import { z } from "zod";
import type { BookingTarget } from "./booking-target.js";
import type { BookingPreview } from "./reservation-slot.js";
import type { ReservationSlot } from "./reservation-slot.js";

export const BookingPolicySchema = z.object({
  allowPrepaid: z.boolean(),
  maxAuthorizedPrepaidCents: z.number().int().nonnegative(),
  maxAuthorizedCancellationNoShowCents: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  allowExperiences: z.boolean(),
  allowPaymentMethodRequired: z.boolean(),
  autoBookAuthorized: z.boolean(),
});

export type BookingPolicy = z.infer<typeof BookingPolicySchema>;

export const PolicyRejectionReason = {
  AUTO_BOOK_NOT_AUTHORIZED: "AUTO_BOOK_NOT_AUTHORIZED",
  AMBIGUOUS_PREVIEW: "AMBIGUOUS_PREVIEW",
  SLOT_MISMATCH: "SLOT_MISMATCH",
  RESTAURANT_MISMATCH: "RESTAURANT_MISMATCH",
  DATE_MISMATCH: "DATE_MISMATCH",
  TIME_MISMATCH: "TIME_MISMATCH",
  PARTY_SIZE_MISMATCH: "PARTY_SIZE_MISMATCH",
  UNEXPECTED_SEATING: "UNEXPECTED_SEATING",
  RESERVATION_KIND_MISMATCH: "RESERVATION_KIND_MISMATCH",
  EXPERIENCE_NOT_AUTHORIZED: "EXPERIENCE_NOT_AUTHORIZED",
  UNKNOWN_RESERVATION_KIND: "UNKNOWN_RESERVATION_KIND",
  UNEXPECTED_PREPAID_REQUIREMENT: "UNEXPECTED_PREPAID_REQUIREMENT",
  PREPAID_AMOUNT_UNKNOWN: "PREPAID_AMOUNT_UNKNOWN",
  PREPAID_AMOUNT_EXCEEDS_AUTHORIZATION:
    "PREPAID_AMOUNT_EXCEEDS_AUTHORIZATION",
  CANCELLATION_FEE_UNKNOWN: "CANCELLATION_FEE_UNKNOWN",
  NO_SHOW_FEE_UNKNOWN: "NO_SHOW_FEE_UNKNOWN",
  CANCELLATION_EXPOSURE_EXCEEDS_AUTHORIZATION:
    "CANCELLATION_EXPOSURE_EXCEEDS_AUTHORIZATION",
  CURRENCY_MISMATCH: "CURRENCY_MISMATCH",
  CURRENCY_UNKNOWN: "CURRENCY_UNKNOWN",
  PAYMENT_METHOD_REQUIRED_NOT_AUTHORIZED:
    "PAYMENT_METHOD_REQUIRED_NOT_AUTHORIZED",
  PAYMENT_REQUIREMENT_UNKNOWN: "PAYMENT_REQUIREMENT_UNKNOWN",
  STRONG_CUSTOMER_AUTHENTICATION_REQUIRED:
    "STRONG_CUSTOMER_AUTHENTICATION_REQUIRED",
  STRONG_CUSTOMER_AUTHENTICATION_UNKNOWN:
    "STRONG_CUSTOMER_AUTHENTICATION_UNKNOWN",
} as const;

export type PolicyRejectionReason =
  (typeof PolicyRejectionReason)[keyof typeof PolicyRejectionReason];

export type PolicyEvaluation =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reasons: readonly PolicyRejectionReason[];
    };

/**
 * Fail-closed evaluation of the exact booking terms returned by an adapter.
 * Every mismatch must be resolved before a booking can proceed.
 */
export function evaluateBookingPreview(
  target: BookingTarget,
  slot: ReservationSlot,
  preview: BookingPreview,
): PolicyEvaluation {
  const reasons: PolicyRejectionReason[] = [];
  const policy = target.bookingPolicy;

  if (!policy.autoBookAuthorized) {
    reasons.push(PolicyRejectionReason.AUTO_BOOK_NOT_AUTHORIZED);
  }
  if (preview.isAmbiguous) {
    reasons.push(PolicyRejectionReason.AMBIGUOUS_PREVIEW);
  }
  if (preview.slotId !== slot.id) {
    reasons.push(PolicyRejectionReason.SLOT_MISMATCH);
  }
  if (
    preview.restaurantId !== target.restaurant.id ||
    slot.restaurantId !== target.restaurant.id
  ) {
    reasons.push(PolicyRejectionReason.RESTAURANT_MISMATCH);
  }
  if (
    preview.localDate !== slot.localDate ||
    preview.localDate < target.dateRange.startDate ||
    preview.localDate > target.dateRange.endDate
  ) {
    reasons.push(PolicyRejectionReason.DATE_MISMATCH);
  }
  if (
    preview.localTime !== slot.localTime ||
    preview.localTime < target.timeWindow.earliest ||
    preview.localTime > target.timeWindow.latest
  ) {
    reasons.push(PolicyRejectionReason.TIME_MISMATCH);
  }
  if (preview.partySize !== target.partySize || slot.partySize !== target.partySize) {
    reasons.push(PolicyRejectionReason.PARTY_SIZE_MISMATCH);
  }
  if (
    preview.seatingType !== slot.seatingType ||
    !target.allowedSeatingTypes.includes(preview.seatingType)
  ) {
    reasons.push(PolicyRejectionReason.UNEXPECTED_SEATING);
  }
  if (
    preview.reservationKind.kind !== slot.reservationKind.kind ||
    (preview.reservationKind.kind === "experience" &&
      slot.reservationKind.kind === "experience" &&
      preview.reservationKind.experienceId !== slot.reservationKind.experienceId)
  ) {
    reasons.push(PolicyRejectionReason.RESERVATION_KIND_MISMATCH);
  }
  if (preview.reservationKind.kind === "experience" && !policy.allowExperiences) {
    reasons.push(PolicyRejectionReason.EXPERIENCE_NOT_AUTHORIZED);
  }
  if (preview.reservationKind.kind === "unknown") {
    reasons.push(PolicyRejectionReason.UNKNOWN_RESERVATION_KIND);
  }
  if (preview.currency.status === "unknown") {
    reasons.push(PolicyRejectionReason.CURRENCY_UNKNOWN);
  } else if (preview.currency.code !== policy.currency) {
    reasons.push(PolicyRejectionReason.CURRENCY_MISMATCH);
  }
  if (preview.paymentRequirement === "unknown") {
    reasons.push(PolicyRejectionReason.PAYMENT_REQUIREMENT_UNKNOWN);
  } else if (
    preview.paymentRequirement === "required" &&
    !policy.allowPaymentMethodRequired
  ) {
    reasons.push(PolicyRejectionReason.PAYMENT_METHOD_REQUIRED_NOT_AUTHORIZED);
  }
  if (preview.strongAuthentication === "required") {
    reasons.push(
      PolicyRejectionReason.STRONG_CUSTOMER_AUTHENTICATION_REQUIRED,
    );
  } else if (preview.strongAuthentication === "unknown") {
    reasons.push(
      PolicyRejectionReason.STRONG_CUSTOMER_AUTHENTICATION_UNKNOWN,
    );
  }

  if (preview.prepaid.status !== "not-required") {
    if (!policy.allowPrepaid) {
      reasons.push(PolicyRejectionReason.UNEXPECTED_PREPAID_REQUIREMENT);
    }
    if (preview.prepaid.status === "required-unknown") {
      reasons.push(PolicyRejectionReason.PREPAID_AMOUNT_UNKNOWN);
    } else if (preview.prepaid.amountCents > policy.maxAuthorizedPrepaidCents) {
      reasons.push(
        PolicyRejectionReason.PREPAID_AMOUNT_EXCEEDS_AUTHORIZATION,
      );
    }
  }

  if (preview.cancellationFee.status === "unknown") {
    reasons.push(PolicyRejectionReason.CANCELLATION_FEE_UNKNOWN);
  }
  if (preview.noShowFee.status === "unknown") {
    reasons.push(PolicyRejectionReason.NO_SHOW_FEE_UNKNOWN);
  }

  const financialExposureExceedsAuthorization = [
    preview.cancellationFee,
    preview.noShowFee,
  ].some(
    (term) =>
      term.status === "known" &&
      term.amountCents > policy.maxAuthorizedCancellationNoShowCents,
  );
  if (financialExposureExceedsAuthorization) {
    reasons.push(
      PolicyRejectionReason.CANCELLATION_EXPOSURE_EXCEEDS_AUTHORIZATION,
    );
  }

  return reasons.length === 0 ? { allowed: true } : { allowed: false, reasons };
}
