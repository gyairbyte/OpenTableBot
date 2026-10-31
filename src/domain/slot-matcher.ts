import { effectiveDiningAreaPolicy, type BookingTarget } from "./booking-target.js";
import type { ReservationSlot } from "./reservation-slot.js";
import {
  isDiningAreaAllowed,
  diningAreaPreferenceRank,
  legacySeatingCategory,
  type DiningAreaOption,
} from "./dining-area.js";

export const SlotRejectionReason = {
  RESTAURANT_MISMATCH: "RESTAURANT_MISMATCH",
  DATE_OUTSIDE_RANGE: "DATE_OUTSIDE_RANGE",
  TIME_OUTSIDE_WINDOW: "TIME_OUTSIDE_WINDOW",
  PARTY_SIZE_MISMATCH: "PARTY_SIZE_MISMATCH",
  SEATING_NOT_ALLOWED: "SEATING_NOT_ALLOWED",
  RESERVATION_KIND_NOT_ALLOWED: "RESERVATION_KIND_NOT_ALLOWED",
} as const;

export type SlotRejectionReason =
  (typeof SlotRejectionReason)[keyof typeof SlotRejectionReason];

export function getSlotRejectionReasons(
  target: BookingTarget,
  slot: ReservationSlot,
): readonly SlotRejectionReason[] {
  const reasons: SlotRejectionReason[] = [];

  if (slot.restaurantId !== target.restaurant.id) {
    reasons.push(SlotRejectionReason.RESTAURANT_MISMATCH);
  }
  if (
    slot.localDate < target.dateRange.startDate ||
    slot.localDate > target.dateRange.endDate
  ) {
    reasons.push(SlotRejectionReason.DATE_OUTSIDE_RANGE);
  }
  if (
    slot.localTime < target.timeWindow.earliest ||
    slot.localTime > target.timeWindow.latest
  ) {
    reasons.push(SlotRejectionReason.TIME_OUTSIDE_WINDOW);
  }
  if (slot.partySize !== target.partySize) {
    reasons.push(SlotRejectionReason.PARTY_SIZE_MISMATCH);
  }
  const diningArea = slot.diningArea ?? legacyDiningArea(slot);
  if (!isDiningAreaAllowed(effectiveDiningAreaPolicy(target), diningArea)) {
    reasons.push(SlotRejectionReason.SEATING_NOT_ALLOWED);
  }
  if (
    slot.reservationKind.kind === "unknown" ||
    (slot.reservationKind.kind === "experience" && !target.bookingPolicy.allowExperiences)
  ) reasons.push(SlotRejectionReason.RESERVATION_KIND_NOT_ALLOWED);

  return reasons;
}

export function isSlotAcceptable(
  target: BookingTarget,
  slot: ReservationSlot,
): boolean {
  return getSlotRejectionReasons(target, slot).length === 0;
}

function minutesSinceMidnight(localTime: string): number {
  const [hours = 0, minutes = 0] = localTime.split(":").map(Number);
  return hours * 60 + minutes;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function legacyDiningArea(slot: ReservationSlot): DiningAreaOption {
  return {
    category: legacySeatingCategory(slot.seatingType),
    label: slot.seatingType,
    providerOrder: 0,
  };
}

/**
 * Ranks acceptable slots by preferred-time distance. Ties resolve by earliest
 * date, earliest time, target seating preference, and finally stable slot ID.
 */
/**
 * Last-resort tie-break between slots at the same time with equal preference:
 * a Standard table beats Bar, Counter and the other seating types. Without it
 * the choice falls to a slot-id hash, so an `any` policy could book a bar seat
 * when a standard table was open. Any explicit dining-area preference ranks
 * ahead of this.
 */
function seatingTieBreakRank(slot: ReservationSlot): number {
  return slot.seatingType === "standard" ? 0 : 1;
}

/** Closest to the preferred time first, then earliest date, then earliest time. */
function compareByPreferredTime(
  preferredMinutes: number,
  left: ReservationSlot,
  right: ReservationSlot,
): number {
  return (
    Math.abs(minutesSinceMidnight(left.localTime) - preferredMinutes) -
      Math.abs(minutesSinceMidnight(right.localTime) - preferredMinutes) ||
    compareText(left.localDate, right.localDate) ||
    compareText(left.localTime, right.localTime)
  );
}

/**
 * Orders time-level slots before any dining-area detail is known, so the best
 * time can be looked up and booked first. It only orders: dining-area policy is
 * applied after discovery, once each slot's exact area is established.
 */
export function rankBaseSlots(
  target: BookingTarget,
  slots: readonly ReservationSlot[],
): readonly ReservationSlot[] {
  const preferredMinutes = minutesSinceMidnight(target.timeWindow.preferred);
  return slots.toSorted(
    (left, right) =>
      compareByPreferredTime(preferredMinutes, left, right) ||
      seatingTieBreakRank(left) - seatingTieBreakRank(right) ||
      compareText(left.id, right.id),
  );
}

export function rankAcceptableSlots(
  target: BookingTarget,
  slots: readonly ReservationSlot[],
): readonly ReservationSlot[] {
  const preferredMinutes = minutesSinceMidnight(target.timeWindow.preferred);

  const eligible = slots.filter((slot) => isSlotAcceptable(target, slot));
  const diningAreaPolicy = effectiveDiningAreaPolicy(target);

  return eligible
    .toSorted((left, right) => {
      return (
        compareByPreferredTime(preferredMinutes, left, right) ||
        diningAreaPreferenceRank(
          diningAreaPolicy,
          left.diningArea ?? legacyDiningArea(left),
        ) -
          diningAreaPreferenceRank(
            diningAreaPolicy,
            right.diningArea ?? legacyDiningArea(right),
          ) ||
        seatingTieBreakRank(left) - seatingTieBreakRank(right) ||
        (left.diningArea?.providerOrder ?? 0) -
          (right.diningArea?.providerOrder ?? 0) ||
        compareText(left.id, right.id)
      );
    });
}
