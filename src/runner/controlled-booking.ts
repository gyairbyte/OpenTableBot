import type { BookingTarget } from "../domain/booking-target.js";
import { evaluateBookingPreview, type PolicyEvaluation } from "../domain/booking-policy.js";
import type { BookingPreview, ReservationSlot } from "../domain/reservation-slot.js";
import type { BookingSubmissionResult, OpenTableBookingAdapter, PreparedBooking } from "../opentable/adapter.js";
import { AdapterFailureCategory, OpenTableAdapterError } from "../opentable/errors.js";

export type ControlledBookingResult =
  | {
      readonly status: "dry-run";
      readonly preview: BookingPreview;
      readonly policy: PolicyEvaluation;
    }
  | {
      readonly status: "submitted";
      readonly preview: BookingPreview;
      readonly prepared: PreparedBooking;
      readonly submission: BookingSubmissionResult;
    };

/** One selected slot, one explicit authorization, one lock, and at most one submit. */
export async function runControlledBooking(
  adapter: OpenTableBookingAdapter,
  target: BookingTarget,
  slot: ReservationSlot,
  options: { readonly execute: boolean },
): Promise<ControlledBookingResult> {
  const preview = await adapter.getBookingPreview(target, slot);
  const policy = evaluateBookingPreview(target, slot, preview);
  if (!policy.allowed) {
    if (!options.execute) return { status: "dry-run", preview, policy };
    throw new OpenTableAdapterError(
      AdapterFailureCategory.POLICY_REJECTED,
      `Booking policy rejected the selected slot: ${policy.reasons.join(", ")}`,
    );
  }
  if (!options.execute) return { status: "dry-run", preview, policy };
  const authorization = await adapter.authorizeBooking(target, slot, preview);
  const prepared = await adapter.prepareBooking(
    target,
    slot,
    preview,
    authorization.authorizationHandle,
  );
  const postLockPolicy = evaluateBookingPreview(target, slot, prepared.preview);
  if (!postLockPolicy.allowed) {
    throw new OpenTableAdapterError(
      AdapterFailureCategory.TERMS_CHANGED,
      `Post-lock booking policy rejected the slot: ${postLockPolicy.reasons.join(", ")}`,
    );
  }
  const submission = await adapter.book(target, slot, prepared);
  return { status: "submitted", preview, prepared, submission };
}
