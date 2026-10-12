import { createHash } from "node:crypto";
import type {
  DetailedAvailability,
  ObservedAvailabilitySlot,
} from "../../domain/availability-detail.js";
import type { BookingTarget } from "../../domain/booking-target.js";
import type {
  BookingPreview,
  ReservationSlot,
} from "../../domain/reservation-slot.js";
import type {
  AuthenticationStatus,
  OpenTableReadAdapter,
  RestaurantSearchQuery,
} from "../adapter.js";
import { AdapterFailureCategory, OpenTableAdapterError } from "../errors.js";
import { normalizeAvailabilityObservation } from "../browser/slot-normalizer.js";
import { normalizeBookingPreview } from "../browser/preview-normalizer.js";
import {
  SafeSearchResultsSchema,
  type SafeSearchResults,
} from "../browser/search-types.js";
import {
  getSlotRejectionReasons,
  isSlotAcceptable,
  SlotRejectionReason,
} from "../../domain/slot-matcher.js";
import { BridgeClientError, type OpenTableBridgeClient } from "./client.js";
import {
  AVAILABILITY_OPERATION_NOT_OBSERVED_MESSAGE,
  AVAILABILITY_PROVIDER_ERRORS_MESSAGE,
  isTransientAvailabilityHttpFailure,
} from "./page-errors.js";
import type {
  FindSlotsResult,
  GetBookingPreviewResult,
  ListDiningAreasResult,
  SearchRestaurantsResult,
} from "./protocol.js";

export interface OpenTableBridgeClientPort {
  connect(): Promise<void>;
  close(): void;
  authenticationStatus(): Promise<AuthenticationStatus>;
  findSlots(request: FindSlotsResult["request"]): Promise<FindSlotsResult>;
  listDiningAreas(request: ListDiningAreasResult["request"]): Promise<ListDiningAreasResult>;
  searchRestaurants(
    request: SearchRestaurantsResult["request"],
  ): Promise<SearchRestaurantsResult>;
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

export function mapBridgeError(error: unknown): never {
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
          : error.code === "LOCK_REJECTED"
            ? AdapterFailureCategory.LOCK_REJECTED
            : error.code === "LOCK_NOT_DISPATCHED"
              ? AdapterFailureCategory.LOCK_NOT_DISPATCHED
              : error.code === "LOCK_OUTCOME_UNKNOWN"
                ? AdapterFailureCategory.LOCK_OUTCOME_UNKNOWN
                : error.code === "REVALIDATION_OUTCOME_UNKNOWN"
                  ? AdapterFailureCategory.REVALIDATION_OUTCOME_UNKNOWN
            : error.code === "LOCK_EXPIRED" || error.code === "BOOKING_AUTHORIZATION_EXPIRED"
              ? AdapterFailureCategory.LOCK_EXPIRED
              : error.code === "BOOKING_INVARIANT_MISMATCH"
                ? AdapterFailureCategory.INVARIANT_MISMATCH
                : error.code === "TERMS_CHANGED"
                  ? AdapterFailureCategory.TERMS_CHANGED
                  : error.code === "PAYMENT_REQUIRED"
                    ? AdapterFailureCategory.PAYMENT_REQUIRED
                    : error.code === "SCA_REQUIRED"
                      ? AdapterFailureCategory.STRONG_AUTHENTICATION_REQUIRED
                      : error.code === "SUBMISSION_REJECTED"
                        ? AdapterFailureCategory.SUBMISSION_REJECTED
                        : error.code === "SUBMISSION_OUTCOME_UNKNOWN"
                          ? AdapterFailureCategory.SUBMISSION_OUTCOME_UNKNOWN
                          : error.code === "DUPLICATE_SUBMISSION_PREVENTED"
                            ? AdapterFailureCategory.DUPLICATE_SUBMISSION_PREVENTED
            : error.code === "EXTENSION_UNAVAILABLE" || error.code === "DEADLINE_EXCEEDED"
      ? AdapterFailureCategory.TRANSIENT_TRANSPORT
      : error.code === "PAGE_NOT_READY"
        ? AdapterFailureCategory.BROWSER_NOT_READY
        : error.code === "PAGE_OPERATION_UNAVAILABLE"
          ? error.message.includes(AVAILABILITY_OPERATION_NOT_OBSERVED_MESSAGE)
            ? AdapterFailureCategory.BROWSER_NOT_READY
            : error.message.includes(AVAILABILITY_PROVIDER_ERRORS_MESSAGE) ||
                isTransientAvailabilityHttpFailure(error.message)
              ? AdapterFailureCategory.TRANSIENT_TRANSPORT
              : AdapterFailureCategory.UNEXPECTED_RESPONSE
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

  async searchRestaurants(query: RestaurantSearchQuery): Promise<SafeSearchResults> {
    const request: SearchRestaurantsResult["request"] = {
      term: query.term,
      ...(query.date === undefined ? {} : { date: query.date }),
      ...(query.time === undefined ? {} : { time: query.time }),
      ...(query.partySize === undefined ? {} : { partySize: query.partySize }),
    };
    let result: SearchRestaurantsResult;
    try {
      result = await this.client.searchRestaurants(request);
    } catch (error) {
      mapBridgeError(error);
    }
    return SafeSearchResultsSchema.parse(result.data);
  }

  async findSlots(target: BookingTarget): Promise<readonly ReservationSlot[]> {
    return (await this.findSlotsDetailed(target)).acceptableSlots;
  }

  async findSlotsDetailed(
    target: BookingTarget,
  ): Promise<DetailedAvailability> {
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
    const observedSlots = new Map<string, ObservedAvailabilitySlot & {
      diningAreas: string[];
    }>();
    const observeSlot = (
      slot: ReservationSlot,
      rejectionReasons: readonly SlotRejectionReason[],
    ): ObservedAvailabilitySlot & { diningAreas: string[] } => {
      const key = `${slot.localDate}|${slot.localTime}|${slot.seatingType}|${slot.reservationKind.kind}`;
      const existing = observedSlots.get(key);
      if (existing !== undefined) return existing;
      const observation: ObservedAvailabilitySlot & { diningAreas: string[] } = {
        localDate: slot.localDate,
        localTime: slot.localTime,
        seatingType: slot.seatingType,
        reservationKind: slot.reservationKind.kind,
        withinWindow: !rejectionReasons.includes(
          SlotRejectionReason.TIME_OUTSIDE_WINDOW,
        ),
        rejectionReasons,
        diningAreas: [],
      };
      observedSlots.set(key, observation);
      return observation;
    };
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
      for (const slot of normalized.slots) {
        const baseRejections = getSlotRejectionReasons(target, slot).filter(
          (reason) => reason !== SlotRejectionReason.SEATING_NOT_ALLOWED,
        );
        const observation = observeSlot(slot, baseRejections);
        if (baseRejections.length > 0) {
          this.options.onDiagnostic?.(
            `Slot ${slot.localDate} ${slot.localTime} ${slot.seatingType} rejected before dining-area discovery: ${baseRejections.join(", ")}`,
          );
          continue;
        }
        if (slot.previewReference === undefined) {
          this.options.onDiagnostic?.(
            `Slot ${slot.localDate} ${slot.localTime} ${slot.seatingType} has no browser preview reference; availability operation may not have been captured`,
          );
          continue;
        }
        let discovered: ListDiningAreasResult;
        try {
          discovered = await this.client.listDiningAreas({
            baseSlotId: slot.id,
            previewReference: slot.previewReference,
            restaurantId: slot.restaurantId,
            date: slot.localDate,
            time: slot.localTime,
            partySize: slot.partySize,
            seatingType: slot.seatingType,
            reservationKind: slot.reservationKind.kind === "experience"
              ? { kind: "experience", experienceId: slot.reservationKind.experienceId }
              : slot.reservationKind,
          });
        } catch (error) {
          mapBridgeError(error);
        }
        if (discovered.candidates.length === 0) {
          this.options.onDiagnostic?.(
            `Slot ${slot.localDate} ${slot.localTime} ${slot.seatingType} produced no exact dining-area candidates`,
          );
        }
        for (const candidate of discovered.candidates) {
          const digest = createHash("sha256")
            .update(`${slot.id}|${candidate.diningArea.category}|${candidate.diningArea.label}|${candidate.diningArea.providerOrder}`)
            .digest("hex")
            .slice(0, 20);
          const exactCandidate: ReservationSlot = {
            ...slot,
            id: `ot-area-${digest}`,
            previewReference: candidate.previewReference,
            diningArea: candidate.diningArea,
          };
          if (isSlotAcceptable(target, exactCandidate)) {
            normalizedSlots.push(exactCandidate);
            if (!observation.diningAreas.includes(candidate.diningArea.label)) {
              observation.diningAreas.push(candidate.diningArea.label);
            }
          }
        }
      }
      for (const diagnostic of normalized.diagnostics) {
        this.options.onDiagnostic?.(`Unknown seating label normalized to other: ${diagnostic.label}`);
      }
    }
    return {
      acceptableSlots: [
        ...new Map(normalizedSlots.map((slot) => [slot.id, slot])).values(),
      ],
      observedSlots: [...observedSlots.values()].map((observation) => ({
        ...observation,
        diningAreas: [...observation.diningAreas],
      })),
    };
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
    if (slot.diningArea === undefined) {
      throw new OpenTableAdapterError(
        AdapterFailureCategory.INVARIANT_MISMATCH,
        "The selected slot has no exact dining-area evidence; find slots again",
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
        diningArea: slot.diningArea,
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
