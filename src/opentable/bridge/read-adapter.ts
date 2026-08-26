import type { BookingTarget } from "../../domain/booking-target.js";
import type {
  BookingPreview,
  ReservationSlot,
} from "../../domain/reservation-slot.js";
import type { AuthenticationStatus, OpenTableReadAdapter } from "../adapter.js";
import { AdapterFailureCategory, OpenTableAdapterError } from "../errors.js";
import { normalizeAvailabilityObservation } from "../browser/slot-normalizer.js";
import { normalizeBookingPreview } from "../browser/preview-normalizer.js";
import { BridgeClientError, type OpenTableBridgeClient } from "./client.js";
import type {
  FindSlotsResult,
  GetBookingPreviewResult,
} from "./protocol.js";

export interface OpenTableBridgeClientPort {
  connect(): Promise<void>;
  close(): void;
  authenticationStatus(): Promise<AuthenticationStatus>;
  findSlots(request: FindSlotsResult["request"]): Promise<FindSlotsResult>;
  getBookingPreview(
    request: GetBookingPreviewResult["request"],
  ): Promise<GetBookingPreviewResult>;
}

export interface BrowserBridgeReadAdapterOptions {
  readonly databaseRegion?: string;
  readonly onDiagnostic?: (message: string) => void;
}

function addOneDay(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 0) + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

function datesInRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  for (let date = startDate; date <= endDate; date = addOneDay(date)) {
    dates.push(date);
    if (dates.length > 366) {
      throw new OpenTableAdapterError(
        AdapterFailureCategory.INVARIANT_MISMATCH,
        "Date range exceeds the read adapter safety limit",
      );
    }
  }
  return dates;
}

function mapBridgeError(error: unknown): never {
  if (!(error instanceof BridgeClientError)) throw error;
  const category =
    error.code === "OPENTABLE_AUTHENTICATION_REQUIRED"
      ? AdapterFailureCategory.AUTHENTICATION_REQUIRED
      : error.code === "PAGE_CHALLENGE"
        ? AdapterFailureCategory.CAPTCHA_OR_CHALLENGE
        : error.code === "ACCESS_CONTROL_RESPONSE"
          ? AdapterFailureCategory.ACCESS_CONTROL_RESPONSE
          : error.code === "RATE_LIMITED"
            ? AdapterFailureCategory.RATE_LIMITED
            : error.code === "EXTENSION_UNAVAILABLE" || error.code === "DEADLINE_EXCEEDED"
      ? AdapterFailureCategory.TRANSIENT_TRANSPORT
      : error.code === "PAGE_NOT_READY"
        ? AdapterFailureCategory.UNEXPECTED_RESPONSE
        : error.code === "PAGE_OPERATION_UNAVAILABLE"
          ? AdapterFailureCategory.UNEXPECTED_RESPONSE
              : AdapterFailureCategory.UNKNOWN;
  throw new OpenTableAdapterError(category, error.message, { cause: error });
}

export class BrowserBridgeOpenTableReadAdapter implements OpenTableReadAdapter {
  constructor(
    private readonly client: OpenTableBridgeClientPort,
    private readonly options: BrowserBridgeReadAdapterOptions = {},
  ) {}

  async start(): Promise<void> {
    try {
      await this.client.connect();
    } catch (error) {
      mapBridgeError(error);
    }
  }

  async close(): Promise<void> {
    this.client.close();
  }

  async checkAuthentication(): Promise<AuthenticationStatus> {
    try {
      return await this.client.authenticationStatus();
    } catch (error) {
      mapBridgeError(error);
    }
  }

  async findSlots(target: BookingTarget): Promise<readonly ReservationSlot[]> {
    const authentication = await this.checkAuthentication();
    if (!authentication.authenticated) {
      throw new OpenTableAdapterError(
        authentication.reason === "expired"
          ? AdapterFailureCategory.AUTHENTICATION_EXPIRED
          : AdapterFailureCategory.AUTHENTICATION_REQUIRED,
        "OpenTable sign-in is required in the paired Chrome browser",
      );
    }

    const normalizedSlots: ReservationSlot[] = [];
    for (const requestedDate of datesInRange(target.dateRange.startDate, target.dateRange.endDate)) {
      let result: FindSlotsResult;
      try {
        result = await this.client.findSlots({
          restaurantId: target.restaurant.id,
          date: requestedDate,
          time: target.timeWindow.preferred,
          partySize: target.partySize,
          databaseRegion: this.options.databaseRegion ?? "NA",
        });
      } catch (error) {
        mapBridgeError(error);
      }
      const normalized = normalizeAvailabilityObservation(
        {
          requestContext: {
            restaurantIds: [result.request.restaurantId],
            date: result.request.date,
            time: result.request.time,
            partySize: result.request.partySize,
          },
          payload: { data: result.data },
        },
        target,
        requestedDate,
      );
      normalizedSlots.push(...normalized.slots);
      for (const diagnostic of normalized.diagnostics) {
        this.options.onDiagnostic?.(`Unknown seating label normalized to other: ${diagnostic.label}`);
      }
    }
    return [...new Map(normalizedSlots.map((slot) => [slot.id, slot])).values()];
  }

  async getBookingPreview(
    target: BookingTarget,
    slot: ReservationSlot,
  ): Promise<BookingPreview> {
    const authentication = await this.checkAuthentication();
    if (!authentication.authenticated) {
      throw new OpenTableAdapterError(
        authentication.reason === "expired"
          ? AdapterFailureCategory.AUTHENTICATION_EXPIRED
          : AdapterFailureCategory.AUTHENTICATION_REQUIRED,
        "OpenTable sign-in is required in the paired Chrome browser",
      );
    }
    if (slot.previewReference === undefined) {
      throw new OpenTableAdapterError(
        AdapterFailureCategory.INVARIANT_MISMATCH,
        "The selected slot has no current browser preview reference; find slots again",
      );
    }
    let result: GetBookingPreviewResult;
    try {
      result = await this.client.getBookingPreview({
        slotId: slot.id,
        previewReference: slot.previewReference,
        restaurantId: target.restaurant.id,
        date: slot.localDate,
        time: slot.localTime,
        partySize: target.partySize,
        seatingType: slot.seatingType,
        reservationKind:
          slot.reservationKind.kind === "experience"
            ? {
                kind: "experience",
                experienceId: slot.reservationKind.experienceId,
              }
            : slot.reservationKind,
      });
    } catch (error) {
      mapBridgeError(error);
    }
    return normalizeBookingPreview(result, target, slot);
  }
}

export function createBrowserBridgeReadAdapter(
  client: OpenTableBridgeClient,
  options?: BrowserBridgeReadAdapterOptions,
): BrowserBridgeOpenTableReadAdapter {
  return new BrowserBridgeOpenTableReadAdapter(client, options);
}
