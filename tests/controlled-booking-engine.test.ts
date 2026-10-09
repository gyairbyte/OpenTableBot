import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  AuthenticationStatus,
  BookingSubmissionResult,
  OpenTableBookingAdapter,
  PreparedBooking,
} from "../src/opentable/adapter.js";
import type { BookingTarget } from "../src/domain/booking-target.js";
import type {
  BookingPreview,
  ReservationSlot,
} from "../src/domain/reservation-slot.js";
import { TargetState } from "../src/domain/target-state.js";
import type { Notification } from "../src/notifications/notifier.js";
import { FileTargetStore } from "../src/storage/file-target-store.js";
import type { TargetRecord } from "../src/storage/target-store.js";
import { ControlledBookingEngine } from "../src/runner/controlled-booking-engine.js";
import { makePreview, makeSlot, makeTarget } from "./fixtures.js";

async function tempDirectory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "otb-engine-"));
}

function bookingAdapter(
  overrides: Partial<OpenTableBookingAdapter> = {},
): OpenTableBookingAdapter {
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
  return {
    checkAuthentication: vi
      .fn<() => Promise<AuthenticationStatus>>()
      .mockResolvedValue({ authenticated: true }),
    findSlots: vi
      .fn<(target: BookingTarget) => Promise<readonly ReservationSlot[]>>()
      .mockResolvedValue([makeSlot()]),
    getBookingPreview: vi
      .fn<
        (target: BookingTarget, slot: ReservationSlot) => Promise<BookingPreview>
      >()
      .mockResolvedValue(preview),
    authorizeBooking: vi.fn().mockResolvedValue({
      authorizationHandle: "authorization-handle",
      expiresAt: "2099-01-01T00:00:00.000Z",
    }),
    prepareBooking: vi.fn().mockResolvedValue(prepared),
    book: vi.fn().mockResolvedValue(submission),
    ...overrides,
  };
}

async function seed(
  store: FileTargetStore,
  overrides: Partial<TargetRecord> = {},
): Promise<void> {
  await store.save(
    {
      target: makeTarget(),
      state: TargetState.ARMED,
      version: 0,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      ...overrides,
    },
    0,
  );
}

function recordingNotifier(events: Notification[]) {
  return {
    notify: async (event: Notification): Promise<void> => {
      events.push(event);
    },
  };
}

describe("ControlledBookingEngine", () => {
  it("books the exact preferred slot and notifies a confirmation", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    await seed(store);
    const events: Notification[] = [];
    const adapter = bookingAdapter();
    const engine = new ControlledBookingEngine(
      { adapter, store, notifier: recordingNotifier(events) },
      { execute: true },
    );

    await engine.runOnce("target-1");

    const record = await store.get("target-1");
    expect(record?.state).toBe("BOOKED");
    expect(record?.confirmation?.confirmationId).toBe("confirmation-1");
    expect(events.some((event) => event.type === "booking-confirmed")).toBe(true);
  });

  it("pauses when the exact preferred time is absent", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    await seed(store);
    const adapter = bookingAdapter({
      findSlots: vi.fn().mockResolvedValue([makeSlot({ localTime: "18:30" })]),
    });
    const engine = new ControlledBookingEngine(
      { adapter, store, notifier: recordingNotifier([]) },
      { execute: true },
    );

    await engine.runOnce("target-1");

    const record = await store.get("target-1");
    expect(record?.state).toBe("PAUSED");
    expect(record?.pauseReason).toContain("preferred");
    expect(adapter.authorizeBooking).not.toHaveBeenCalled();
  });

  it("pauses after a dry run without locking or submitting", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    await seed(store);
    const adapter = bookingAdapter();
    const engine = new ControlledBookingEngine(
      { adapter, store, notifier: recordingNotifier([]) },
      { execute: false },
    );

    await engine.runOnce("target-1");

    expect((await store.get("target-1"))?.state).toBe("PAUSED");
    expect(adapter.authorizeBooking).not.toHaveBeenCalled();
    expect(adapter.book).not.toHaveBeenCalled();
  });

  it("pauses fail-closed when slot discovery fails", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    await seed(store);
    const adapter = bookingAdapter({
      findSlots: vi.fn().mockRejectedValue(new Error("bridge unavailable")),
    });
    const engine = new ControlledBookingEngine(
      { adapter, store, notifier: recordingNotifier([]) },
      { execute: true },
    );

    await engine.runOnce("target-1");

    const record = await store.get("target-1");
    expect(record?.state).toBe("PAUSED");
    expect(record?.pauseReason).toContain("bridge unavailable");
  });
});
