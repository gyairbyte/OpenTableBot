import { z } from "zod";
import type { BookingTarget } from "./booking-target.js";
import type { BookingPreview } from "./reservation-slot.js";
import type { ReservationSlot } from "./reservation-slot.js";

export const BookingPolicySchema = z.object({
  allowPrepaid: z.boolean(),
  maxAuthorizedPrepaidCents: z.number().int().nonnegative(),
  maxAuthorizedCancellationNoShowCents: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
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
  UNEXPECTED_PREPAID_REQUIREMENT: "UNEXPECTED_PREPAID_REQUIREMENT",
  PREPAID_AMOUNT_MISSING: "PREPAID_AMOUNT_MISSING",
  PREPAID_AMOUNT_EXCEEDS_AUTHORIZATION:
    "PREPAID_AMOUNT_EXCEEDS_AUTHORIZATION",
  CANCELLATION_EXPOSURE_EXCEEDS_AUTHORIZATION:
    "CANCELLATION_EXPOSURE_EXCEEDS_AUTHORIZATION",
  CURRENCY_MISMATCH: "CURRENCY_MISMATCH",
  STRONG_CUSTOMER_AUTHENTICATION_REQUIRED:
    "STRONG_CUSTOMER_AUTHENTICATION_REQUIRED",
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
  if (preview.currency !== policy.currency) {
    reasons.push(PolicyRejectionReason.CURRENCY_MISMATCH);
  }
  if (preview.requiresStrongCustomerAuthentication) {
    reasons.push(
      PolicyRejectionReason.STRONG_CUSTOMER_AUTHENTICATION_REQUIRED,
    );
  }

  if (preview.prepaidRequired) {
    if (!policy.allowPrepaid) {
      reasons.push(PolicyRejectionReason.UNEXPECTED_PREPAID_REQUIREMENT);
    }
    if (preview.prepaidAmountCents === undefined) {
      reasons.push(PolicyRejectionReason.PREPAID_AMOUNT_MISSING);
    } else if (
      preview.prepaidAmountCents > policy.maxAuthorizedPrepaidCents
    ) {
      reasons.push(
        PolicyRejectionReason.PREPAID_AMOUNT_EXCEEDS_AUTHORIZATION,
      );
    }
  }

  const cancellationExposure = Math.max(
    preview.cancellationFeeCents ?? 0,
    preview.noShowFeeCents ?? 0,
  );
  if (
    cancellationExposure > policy.maxAuthorizedCancellationNoShowCents
  ) {
    reasons.push(
      PolicyRejectionReason.CANCELLATION_EXPOSURE_EXCEEDS_AUTHORIZATION,
    );
  }

  return reasons.length === 0 ? { allowed: true } : { allowed: false, reasons };
}
