import type { BookingTarget } from "../domain/booking-target.js";
import {
  evaluateBookingPreview,
  type PolicyEvaluation,
} from "../domain/booking-policy.js";
import type { ReservationSlot } from "../domain/reservation-slot.js";
import { rankAcceptableSlots } from "../domain/slot-matcher.js";
import type {
  OpenTableBookingAdapter,
  PreparedBooking,
} from "../opentable/adapter.js";
import type { Notifier } from "../notifications/notifier.js";
import type { TargetStore } from "../storage/target-store.js";

export type BookingPlan =
  | { readonly kind: "no-match" }
  | {
      readonly kind: "candidate";
      readonly selected: ReservationSlot;
      readonly fallbacks: readonly ReservationSlot[];
    };

/** Pure planning used by schedulers before any preview or booking side effect. */
export function createBookingPlan(
  target: BookingTarget,
  slots: readonly ReservationSlot[],
): BookingPlan {
  const ranked = rankAcceptableSlots(target, slots);
  const [selected, ...fallbacks] = ranked;
  return selected === undefined
    ? { kind: "no-match" }
    : { kind: "candidate", selected, fallbacks };
}

export function validatePreparedBooking(
  target: BookingTarget,
  slot: ReservationSlot,
  preparedBooking: PreparedBooking,
): PolicyEvaluation {
  return evaluateBookingPreview(target, slot, preparedBooking.preview);
}

export interface BookingEngineDependencies {
  readonly adapter: OpenTableBookingAdapter;
  readonly store: TargetStore;
  readonly notifier: Notifier;
}

/**
 * Phase 0 port for the future scheduler-driven coordinator. Concrete execution
 * is intentionally deferred until adapter preview and controlled-booking phases.
 */
export interface BookingEngine {
  runOnce(targetId: string): Promise<void>;
}
