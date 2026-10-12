import type { BookingTarget } from "../src/domain/booking-target.js";
import type {
  BookingPreview,
  ReservationSlot,
} from "../src/domain/reservation-slot.js";

export function makeTarget(
  overrides: Partial<BookingTarget> = {},
): BookingTarget {
  return {
    id: "target-1",
    restaurant: {
      id: "restaurant-123",
      name: "Example Restaurant",
      timeZone: "America/New_York",
    },
    dateRange: { startDate: "2026-09-01", endDate: "2026-09-01" },
    partySize: 2,
    timeWindow: { earliest: "18:00", latest: "20:00", preferred: "19:00" },
    allowedSeatingTypes: ["standard", "outdoor"],
    bookingPolicy: {
      allowPrepaid: true,
      maxAuthorizedPrepaidDollars: 100,
      maxAuthorizedCancellationNoShowDollarsPerPerson: 25,
      currency: "USD",
      allowExperiences: false,
      allowPaymentMethodRequired: false,
      autoBookAuthorized: true,
    },
    mode: "known-drop",
    knownReservationReleaseAt: "2026-08-01T13:00:00-04:00",
    ...overrides,
  };
}

export function makeSlot(
  overrides: Partial<ReservationSlot> = {},
): ReservationSlot {
  return {
    id: "slot-1",
    restaurantId: "restaurant-123",
    startsAt: "2026-09-01T19:00:00-04:00",
    localDate: "2026-09-01",
    localTime: "19:00",
    partySize: 2,
    seatingType: "standard",
    diningArea: {
      category: "dining-room",
      label: "Dining Room",
      providerOrder: 0,
    },
    previewReference: "00000000-0000-4000-8000-000000000001",
    reservationKind: { kind: "standard" },
    ...overrides,
  };
}

export function makePreview(
  overrides: Partial<BookingPreview> = {},
): BookingPreview {
  return {
    slotId: "slot-1",
    restaurantId: "restaurant-123",
    localDate: "2026-09-01",
    localTime: "19:00",
    partySize: 2,
    seatingType: "standard",
    diningArea: {
      category: "dining-room",
      label: "Dining Room",
      providerOrder: 0,
    },
    reservationKind: { kind: "standard" },
    prepaid: { status: "not-required" },
    cancellationFee: { status: "none" },
    noShowFee: { status: "none" },
    currency: { status: "known", code: "USD" },
    paymentRequirement: "not-required",
    strongAuthentication: "not-required",
    isAmbiguous: false,
    ...overrides,
  };
}
