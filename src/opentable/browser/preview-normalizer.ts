import type { BookingTarget } from "../../domain/booking-target.js";
import {
  BookingPreviewSchema,
  type BookingPreview,
  type FinancialTerm,
  type PrepaidTerm,
  type ReservationSlot,
} from "../../domain/reservation-slot.js";
import { AdapterFailureCategory, OpenTableAdapterError } from "../errors.js";
import {
  GetBookingPreviewResultSchema,
  type GetBookingPreviewResult,
} from "../bridge/protocol.js";

function malformed(message: string): OpenTableAdapterError {
  return new OpenTableAdapterError(AdapterFailureCategory.MALFORMED_RESPONSE, message);
}

function invariant(message: string): OpenTableAdapterError {
  return new OpenTableAdapterError(AdapterFailureCategory.INVARIANT_MISMATCH, message);
}

function providerSeatingType(seatingType: ReservationSlot["seatingType"]): string {
  if (seatingType === "standard") return "default";
  if (seatingType === "high-top") return "highTop";
  if (seatingType === "private-dining") return "privateDining";
  return seatingType;
}

function normalizeSummary(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/gu, " ").trim().slice(0, 2_000);
  return normalized === "" ? undefined : normalized;
}

interface ParsedAmount {
  readonly amountCents: number;
  readonly perPerson: boolean;
}

function parseAmount(summary: string | undefined, partySize: number): ParsedAmount | undefined {
  if (summary === undefined) return undefined;
  const match = summary.match(
    /(?:[$£€]|\b(?:USD|CAD|AUD|GBP|EUR)\s*)(\d+(?:[.,]\d{1,2})?)/iu,
  );
  if (match?.[1] === undefined) return undefined;
  const amount = Number(match[1].replace(",", "."));
  if (!Number.isFinite(amount) || amount < 0) return undefined;
  const perPerson = /per\s+(?:person|guest|diner|cover)/iu.test(summary);
  const amountCents = Math.round(amount * 100) * (perPerson ? partySize : 1);
  return { amountCents, perPerson };
}

function financialTerms(
  summary: string | undefined,
  partySize: number,
  paymentRequired: boolean | undefined,
): {
  readonly cancellationFee: FinancialTerm;
  readonly noShowFee: FinancialTerm;
} {
  const hasCancellation = summary !== undefined && /cancel/iu.test(summary);
  const hasNoShow = summary !== undefined && /no[\s-]?show/iu.test(summary);
  const parsedAmount = parseAmount(summary, partySize);
  const relationshipIsClear =
    !(hasCancellation && hasNoShow) ||
    (summary !== undefined && /\b(?:or|and\/or)\b/iu.test(summary));
  const unknown: FinancialTerm = {
    status: "unknown",
    ...(summary === undefined ? {} : { summary }),
  };
  const none: FinancialTerm = {
    status: "none",
    ...(summary === undefined ? {} : { summary }),
  };
  const known =
    parsedAmount === undefined || !relationshipIsClear
      ? undefined
      : ({
          status: "known",
          amountCents: parsedAmount.amountCents,
          ...(summary === undefined ? {} : { summary }),
        } satisfies FinancialTerm);

  if (summary === undefined) {
    return paymentRequired === false
      ? { cancellationFee: none, noShowFee: none }
      : { cancellationFee: unknown, noShowFee: unknown };
  }
  return {
    cancellationFee: hasCancellation ? (known ?? unknown) : paymentRequired ? unknown : none,
    noShowFee: hasNoShow ? (known ?? unknown) : paymentRequired ? unknown : none,
  };
}

function prepaidTerm(
  policyType: string | undefined,
  depositMessage: string | undefined,
  partySize: number,
): PrepaidTerm {
  if (policyType?.toLowerCase() !== "deposit") {
    return { status: "not-required" };
  }
  const parsed = parseAmount(depositMessage, partySize);
  return parsed === undefined
    ? {
        status: "required-unknown",
        ...(depositMessage === undefined ? {} : { summary: depositMessage }),
      }
    : {
        status: "required-known",
        amountCents: parsed.amountCents,
        ...(depositMessage === undefined ? {} : { summary: depositMessage }),
      };
}

export function normalizeBookingPreview(
  result: GetBookingPreviewResult,
  target: BookingTarget,
  slot: ReservationSlot,
): BookingPreview {
  const parsedResult = GetBookingPreviewResultSchema.safeParse(result);
  if (!parsedResult.success) throw malformed("Malformed booking preview response");
  const { request, data } = parsedResult.data;
  if (
    request.slotId !== slot.id ||
    request.previewReference !== slot.previewReference
  ) {
    throw invariant("Booking preview did not match the selected slot reference");
  }
  if (
    request.restaurantId !== target.restaurant.id ||
    request.restaurantId !== slot.restaurantId ||
    String(data.restaurantId) !== target.restaurant.id
  ) {
    throw invariant("Booking preview restaurant did not match the target");
  }
  if (
    request.date !== slot.localDate ||
    data.reservationDateTime.slice(0, 10) !== slot.localDate
  ) {
    throw invariant("Booking preview date did not match the selected slot");
  }
  if (
    request.time !== slot.localTime ||
    data.reservationDateTime.slice(11, 16) !== slot.localTime
  ) {
    throw invariant("Booking preview time did not match the selected slot");
  }
  if (request.partySize !== slot.partySize || data.partySize !== target.partySize) {
    throw invariant("Booking preview party size did not match the target");
  }
  if (
    request.seatingType !== slot.seatingType ||
    data.seatingType.toLowerCase().replace(/[\s_-]/gu, "") !==
      providerSeatingType(slot.seatingType).toLowerCase().replace(/[\s_-]/gu, "") ||
    data.diningArea.tableCategory.toLowerCase().replace(/[\s_-]/gu, "") !==
      data.seatingType.toLowerCase().replace(/[\s_-]/gu, "")
  ) {
    throw invariant("Booking preview seating did not match the selected slot");
  }
  if (request.reservationKind.kind !== slot.reservationKind.kind) {
    throw invariant("Booking preview reservation type did not match the selected slot");
  }

  let reservationKind: BookingPreview["reservationKind"];
  if (slot.reservationKind.kind === "experience") {
    if (
      request.reservationKind.kind !== "experience" ||
      request.reservationKind.experienceId !== slot.reservationKind.experienceId ||
      data.experience === undefined ||
      String(data.experience.id) !== slot.reservationKind.experienceId
    ) {
      throw invariant("Booking preview Experience did not match the selected slot");
    }
    reservationKind = {
      kind: "experience",
      experienceId: slot.reservationKind.experienceId,
      name: data.experience.name,
      ...(data.experience.type === undefined ? {} : { type: data.experience.type }),
      ...(data.experience.summary === undefined
        ? {}
        : { summary: data.experience.summary }),
    };
  } else if (slot.reservationKind.kind === "standard") {
    if (data.reservationType !== undefined && !/^standard$/iu.test(data.reservationType)) {
      throw invariant("Booking preview provider type was not Standard");
    }
    reservationKind = { kind: "standard" };
  } else {
    reservationKind = slot.reservationKind;
  }

  const cancellationSummary = normalizeSummary(
    data.cancellationMessage ?? data.termsMessage,
  );
  const depositSummary = normalizeSummary(data.depositMessage);
  const paymentRequirement =
    data.creditCardRequired === true
      ? "required"
      : data.creditCardRequired === false
        ? "not-required"
        : "unknown";
  const strongAuthentication =
    data.strongAuthenticationRequired === true
      ? "required"
      : data.strongAuthenticationRequired === false
        ? "not-required"
        : paymentRequirement === "not-required"
          ? "not-required"
          : "unknown";
  const fees = financialTerms(
    cancellationSummary,
    target.partySize,
    data.creditCardRequired,
  );
  const explicitCurrency = data.currencyCode ?? data.experience?.currencyCode;

  try {
    return BookingPreviewSchema.parse({
      slotId: slot.id,
      restaurantId: target.restaurant.id,
      localDate: slot.localDate,
      localTime: slot.localTime,
      partySize: target.partySize,
      seatingType: slot.seatingType,
      reservationKind,
      prepaid: prepaidTerm(
        data.creditCardPolicyType,
        depositSummary,
        target.partySize,
      ),
      cancellationFee: fees.cancellationFee,
      noShowFee: fees.noShowFee,
      currency:
        explicitCurrency === undefined
          ? { status: "unknown" }
          : { status: "known", code: explicitCurrency },
      paymentRequirement,
      strongAuthentication,
      ...(data.termsMessage === undefined
        ? {}
        : { termsSummary: normalizeSummary(data.termsMessage) }),
      isAmbiguous: reservationKind.kind === "unknown",
    });
  } catch (error) {
    throw malformed(error instanceof Error ? error.message : "Malformed booking preview");
  }
}
