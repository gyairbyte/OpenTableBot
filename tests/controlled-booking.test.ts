import { describe, expect, it, vi } from "vitest";
import type { DetailedAvailability } from "../src/domain/availability-detail.js";
import type {
  AuthenticationStatus,
  BookingSubmissionResult,
  OpenTableBookingAdapter,
  PreparedBooking,
} from "../src/opentable/adapter.js";
import type { BookingTarget } from "../src/domain/booking-target.js";
import type { BookingPreview, ReservationSlot } from "../src/domain/reservation-slot.js";
import { runControlledBooking } from "../src/runner/controlled-booking.js";
import { makePreview, makeSlot, makeTarget } from "./fixtures.js";

function adapterFixture(overrides: Partial<OpenTableBookingAdapter> = {}) {
  const preview = makePreview();
  const prepared: PreparedBooking = {
    preview,
    bookingHandle: "00000000-0000-4000-8000-000000000010",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  const submission: BookingSubmissionResult = {
    status: "confirmed",
    confirmation: {
      confirmationId: "confirmation-1",
      slotId: "slot-1",
      restaurantId: "restaurant-123",
      startsAt: "2026-09-01T19:00:00-04:00",
      partySize: 2,
      seatingType: "standard",
      bookedAt: "2026-08-26T12:00:00.000Z",
    },
  };
  const adapter: OpenTableBookingAdapter = {
    checkAuthentication: vi.fn<() => Promise<AuthenticationStatus>>().mockResolvedValue({ authenticated: true }),
    findSlots: vi.fn<(target: BookingTarget) => Promise<readonly ReservationSlot[]>>().mockResolvedValue([makeSlot()]),
    findSlotsDetailed: vi.fn<(target: BookingTarget) => Promise<DetailedAvailability>>().mockResolvedValue({ acceptableSlots: [makeSlot()], observedSlots: [] }),
    getBookingPreview: vi.fn<(target: BookingTarget, slot: ReservationSlot) => Promise<BookingPreview>>().mockResolvedValue(preview),
    authorizeBooking: vi.fn().mockResolvedValue({
      authorizationHandle: "00000000-0000-4000-8000-000000000009",
      expiresAt: "2099-01-01T00:00:00.000Z",
    }),
    prepareBooking: vi.fn().mockResolvedValue(prepared),
    book: vi.fn().mockResolvedValue(submission),
    ...overrides,
  };
  return { adapter, preview, prepared, submission };
}

describe("controlled single-shot booking", () => {
  it("does not authorize, lock, or submit without --execute", async () => {
    const { adapter } = adapterFixture();
    const result = await runControlledBooking(adapter, makeTarget(), makeSlot(), { execute: false });
    expect(result.status).toBe("dry-run");
    expect(adapter.authorizeBooking).not.toHaveBeenCalled();
    expect(adapter.prepareBooking).not.toHaveBeenCalled();
    expect(adapter.book).not.toHaveBeenCalled();
  });

  it("runs exactly one authorization, lock, and submission for an approved slot", async () => {
    const { adapter } = adapterFixture();
    const result = await runControlledBooking(adapter, makeTarget(), makeSlot(), { execute: true });
    expect(result.status).toBe("submitted");
    expect(adapter.authorizeBooking).toHaveBeenCalledTimes(1);
    expect(adapter.prepareBooking).toHaveBeenCalledTimes(1);
    expect(adapter.book).toHaveBeenCalledTimes(1);
  });

  it("does not create a capability when the pre-lock policy fails", async () => {
    const { adapter } = adapterFixture({
      getBookingPreview: vi.fn().mockResolvedValue(makePreview({ strongAuthentication: "required" })),
    });
    await expect(runControlledBooking(adapter, makeTarget(), makeSlot(), { execute: true })).rejects.toThrow("policy rejected");
    expect(adapter.authorizeBooking).not.toHaveBeenCalled();
  });

  it("does not submit when terms change after lock", async () => {
    const changed: PreparedBooking = {
      preview: makePreview({ paymentRequirement: "required" }),
      bookingHandle: "00000000-0000-4000-8000-000000000010",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    const { adapter } = adapterFixture({ prepareBooking: vi.fn().mockResolvedValue(changed) });
    await expect(runControlledBooking(adapter, makeTarget(), makeSlot(), { execute: true })).rejects.toThrow("Post-lock");
    expect(adapter.book).not.toHaveBeenCalled();
  });

  it("returns OUTCOME_UNKNOWN without making a second submission", async () => {
    const unknown: BookingSubmissionResult = {
      status: "outcome-unknown",
      message: "Dispatched; confirmation unavailable; do not retry",
    };
    const { adapter } = adapterFixture({ book: vi.fn().mockResolvedValue(unknown) });
    const result = await runControlledBooking(adapter, makeTarget(), makeSlot(), { execute: true });
    expect(result.status).toBe("submitted");
    if (result.status === "submitted") expect(result.submission.status).toBe("outcome-unknown");
    expect(adapter.book).toHaveBeenCalledTimes(1);
  });
});
