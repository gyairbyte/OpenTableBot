import type { BookingTarget } from "../../domain/booking-target.js";
import type { ReservationSlot } from "../../domain/reservation-slot.js";
import type {
  AuthenticationStatus,
  OpenTableReadAdapter,
} from "../adapter.js";
import {
  AdapterFailureCategory,
  OpenTableAdapterError,
} from "../errors.js";
import type { OpenTableBrowserSessionPort } from "./browser-session.js";
import {
  classifyOpenTablePage,
  OpenTablePageKind,
  type OpenTablePageClassification,
} from "./page-classifier.js";
import { normalizeAvailabilityObservation } from "./slot-normalizer.js";

export interface OpenTableReadAdapterOptions {
  readonly availabilityTimeoutMs?: number;
  readonly onDiagnostic?: (message: string) => void;
}

function pageFailure(classification: OpenTablePageClassification): never {
  const category =
    classification.kind === OpenTablePageKind.CHALLENGE
      ? AdapterFailureCategory.CAPTCHA_OR_CHALLENGE
      : classification.kind === OpenTablePageKind.ACCESS_DENIED
        ? AdapterFailureCategory.ACCESS_CONTROL_RESPONSE
        : classification.kind === OpenTablePageKind.RATE_LIMITED
          ? AdapterFailureCategory.RATE_LIMITED
          : classification.kind === OpenTablePageKind.UNAUTHENTICATED
            ? AdapterFailureCategory.AUTHENTICATION_REQUIRED
            : AdapterFailureCategory.UNEXPECTED_RESPONSE;
  throw new OpenTableAdapterError(category, classification.reason);
}

function failureForStatus(status: number): never {
  const category =
    status === 401
      ? AdapterFailureCategory.AUTHENTICATION_REQUIRED
      : status === 403
        ? AdapterFailureCategory.ACCESS_CONTROL_RESPONSE
        : status === 429
          ? AdapterFailureCategory.RATE_LIMITED
          : AdapterFailureCategory.UNEXPECTED_RESPONSE;
  throw new OpenTableAdapterError(
    category,
    `Availability response failed with HTTP ${status}`,
  );
}

function addOneDay(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(
    Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 0) + 1),
  );
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(
    2,
    "0",
  )}-${String(next.getUTCDate()).padStart(2, "0")}`;
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

export function buildOpenTableAvailabilityPageUrl(
  target: BookingTarget,
  requestedDate: string,
): string {
  const url = new URL("https://www.opentable.com/s");
  url.searchParams.set(
    "dateTime",
    `${requestedDate}T${target.timeWindow.preferred}`,
  );
  url.searchParams.set("covers", String(target.partySize));
  url.searchParams.set("term", target.restaurant.name);
  return url.toString();
}

export class PlaywrightOpenTableReadAdapter implements OpenTableReadAdapter {
  constructor(
    private readonly session: OpenTableBrowserSessionPort,
    private readonly options: OpenTableReadAdapterOptions = {},
  ) {}

  async start(): Promise<void> {
    await this.session.start();
  }

  async close(): Promise<void> {
    await this.session.close();
  }

  async checkAuthentication(): Promise<AuthenticationStatus> {
    const evidence = await this.session.getAuthenticationEvidence();
    const classification = classifyOpenTablePage(evidence);
    if (classification.kind === OpenTablePageKind.AUTHENTICATED) {
      return { authenticated: true };
    }
    if (classification.kind === OpenTablePageKind.UNAUTHENTICATED) {
      return { authenticated: false, reason: "required" };
    }
    pageFailure(classification);
  }

  async findSlots(target: BookingTarget): Promise<readonly ReservationSlot[]> {
    const authentication = await this.checkAuthentication();
    if (!authentication.authenticated) {
      throw new OpenTableAdapterError(
        AdapterFailureCategory.AUTHENTICATION_REQUIRED,
        "OpenTable sign-in is required in the dedicated browser profile",
      );
    }

    const normalizedSlots: ReservationSlot[] = [];
    for (const requestedDate of datesInRange(
      target.dateRange.startDate,
      target.dateRange.endDate,
    )) {
      const result = await this.session.observeAvailability(
        buildOpenTableAvailabilityPageUrl(target, requestedDate),
        this.options.availabilityTimeoutMs ?? 15_000,
      );
      const classification = classifyOpenTablePage(result.pageEvidence);
      if (
        classification.kind !== OpenTablePageKind.NORMAL &&
        classification.kind !== OpenTablePageKind.AUTHENTICATED
      ) {
        pageFailure(classification);
      }

      if (result.outcome.kind === "http-failure") {
        failureForStatus(result.outcome.status);
      }
      if (result.outcome.kind === "malformed") {
        throw new OpenTableAdapterError(
          AdapterFailureCategory.MALFORMED_RESPONSE,
          "Observed availability response was not valid JSON",
        );
      }
      if (result.outcome.kind === "not-observed") {
        throw new OpenTableAdapterError(
          AdapterFailureCategory.UNEXPECTED_RESPONSE,
          "No naturally generated availability response was observed",
        );
      }

      const normalized = normalizeAvailabilityObservation(
        result.outcome.observation,
        target,
        requestedDate,
      );
      normalizedSlots.push(...normalized.slots);
      for (const diagnostic of normalized.diagnostics) {
        this.options.onDiagnostic?.(
          `Unknown seating label normalized to other: ${diagnostic.label}`,
        );
      }
    }

    return [
      ...new Map(normalizedSlots.map((slot) => [slot.id, slot])).values(),
    ];
  }
}
