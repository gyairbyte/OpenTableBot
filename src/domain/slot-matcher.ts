import type { BookingTarget } from "./booking-target.js";
import type { ReservationSlot } from "./reservation-slot.js";

export const SlotRejectionReason = {
  RESTAURANT_MISMATCH: "RESTAURANT_MISMATCH",
  DATE_OUTSIDE_RANGE: "DATE_OUTSIDE_RANGE",
  TIME_OUTSIDE_WINDOW: "TIME_OUTSIDE_WINDOW",
  PARTY_SIZE_MISMATCH: "PARTY_SIZE_MISMATCH",
  SEATING_NOT_ALLOWED: "SEATING_NOT_ALLOWED",
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
  if (!target.allowedSeatingTypes.includes(slot.seatingType)) {
    reasons.push(SlotRejectionReason.SEATING_NOT_ALLOWED);
  }

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

/**
 * Ranks acceptable slots by preferred-time distance. Ties resolve by earliest
 * date, earliest time, target seating preference, and finally stable slot ID.
 */
export function rankAcceptableSlots(
  target: BookingTarget,
  slots: readonly ReservationSlot[],
): readonly ReservationSlot[] {
  const preferredMinutes = minutesSinceMidnight(target.timeWindow.preferred);

  return slots
    .filter((slot) => isSlotAcceptable(target, slot))
    .toSorted((left, right) => {
      const leftDistance = Math.abs(
        minutesSinceMidnight(left.localTime) - preferredMinutes,
      );
      const rightDistance = Math.abs(
        minutesSinceMidnight(right.localTime) - preferredMinutes,
      );

      return (
        leftDistance - rightDistance ||
        compareText(left.localDate, right.localDate) ||
        compareText(left.localTime, right.localTime) ||
        target.allowedSeatingTypes.indexOf(left.seatingType) -
          target.allowedSeatingTypes.indexOf(right.seatingType) ||
        compareText(left.id, right.id)
      );
    });
}
