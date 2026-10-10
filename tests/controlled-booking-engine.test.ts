import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  DetailedAvailability,
  ObservedAvailabilitySlot,
} from "../src/domain/availability-detail.js";
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

function observed(
  overrides: Partial<ObservedAvailabilitySlot> = {},
): ObservedAvailabilitySlot {
  return {
    localDate: "2026-09-01",
    localTime: "19:00",
    seatingType: "standard",
    reservationKind: "standard",
    withinWindow: true,
    rejectionReasons: [],
    diningAreas: ["Dining Room"],
    ...overrides,
  };
}

function detailed(
  acceptableSlots: readonly ReservationSlot[],
  observedSlots: readonly ObservedAvailabilitySlot[] = [],
): DetailedAvailability {
  return { acceptableSlots, observedSlots };
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
    findSlotsDetailed: vi
      .fn<(target: BookingTarget) => Promise<DetailedAvailability>>()
      .mockResolvedValue(detailed([makeSlot()])),
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

  it("can run a target that is already waiting", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    await seed(store, { state: TargetState.WAITING });
    const adapter = bookingAdapter();
    const engine = new ControlledBookingEngine(
      { adapter, store, notifier: recordingNotifier([]) },
      { execute: true },
    );

    await engine.runOnce("target-1");

    expect((await store.get("target-1"))?.state).toBe("BOOKED");
  });

  it("pauses when the exact preferred time is absent", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    await seed(store);
    const adapter = bookingAdapter({
      findSlotsDetailed: vi
        .fn<(target: BookingTarget) => Promise<DetailedAvailability>>()
        .mockResolvedValue(
          detailed(
            [makeSlot({ localTime: "18:30" })],
            [observed({ localTime: "18:30" })],
          ),
        ),
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

  it("records every observed time, including out-of-window, in the pause detail", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    await seed(store);
    const adapter = bookingAdapter({
      findSlotsDetailed: vi
        .fn<(target: BookingTarget) => Promise<DetailedAvailability>>()
        .mockResolvedValue(
          detailed([], [
            observed({
              localTime: "20:30",
              withinWindow: false,
              diningAreas: [],
            }),
            observed({
              localTime: "20:45",
              withinWindow: false,
              rejectionReasons: ["TIME_OUTSIDE_WINDOW"],
              diningAreas: [],
            }),
          ]),
        ),
    });
    const engine = new ControlledBookingEngine(
      { adapter, store, notifier: recordingNotifier([]) },
      {
        execute: true,
        now: () => Date.parse("2026-10-10T14:00:00.000Z"),
      },
    );

    await engine.runOnce("target-1");

    const record = await store.get("target-1");
    expect(record?.state).toBe("PAUSED");
    expect(record?.pauseReason).toContain("preferred");
    expect(record?.pauseReason).toContain(
      "2 open time(s) were all outside the 18:00-20:00 window",
    );
    const detail = record?.availabilityDetail;
    expect(detail?.matched).toBe(false);
    expect(detail?.preferredTime).toBe("19:00");
    expect(detail?.earliest).toBe("18:00");
    expect(detail?.latest).toBe("20:00");
    expect(detail?.capturedAt).toBe("2026-10-10T14:00:00.000Z");
    expect(detail?.attempts).toHaveLength(1);
    const attempt = detail?.attempts[0];
    expect(attempt?.acceptableSlots).toBe(0);
    expect(attempt?.preferredSlots).toBe(0);
    expect(attempt?.durationMs).toBe(0);
    expect(attempt?.startedAt).toBe("2026-10-10T14:00:00.000Z");
    expect(attempt?.observedSlots).toHaveLength(2);
    expect(attempt?.observedSlots[0]?.withinWindow).toBe(false);
    expect(attempt?.observedSlots[1]?.withinWindow).toBe(false);
    expect(attempt?.observedSlots[1]?.rejectionReasons).toEqual([
      "TIME_OUTSIDE_WINDOW",
    ]);
  });

  it("distinguishes a run that observed no open times at all", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    await seed(store);
    const adapter = bookingAdapter({
      findSlotsDetailed: vi
        .fn<(target: BookingTarget) => Promise<DetailedAvailability>>()
        .mockResolvedValue(detailed([])),
    });
    const engine = new ControlledBookingEngine(
      { adapter, store, notifier: recordingNotifier([]) },
      { execute: true },
    );

    await engine.runOnce("target-1");

    const record = await store.get("target-1");
    expect(record?.state).toBe("PAUSED");
    expect(record?.pauseReason).toContain("no open times were observed at all");
    expect(record?.availabilityDetail?.attempts[0]?.observedSlots).toEqual([]);
  });

  it("keeps the detail of a successful run alongside the confirmation", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    await seed(store);
    const adapter = bookingAdapter({
      findSlotsDetailed: vi
        .fn<(target: BookingTarget) => Promise<DetailedAvailability>>()
        .mockResolvedValue(
          detailed([makeSlot()], [observed({ localTime: "19:00" })]),
        ),
    });
    const engine = new ControlledBookingEngine(
      { adapter, store, notifier: recordingNotifier([]) },
      { execute: true },
    );

    await engine.runOnce("target-1");

    const record = await store.get("target-1");
    expect(record?.state).toBe("BOOKED");
    expect(record?.availabilityDetail?.matched).toBe(true);
    expect(record?.availabilityDetail?.attempts[0]?.preferredSlots).toBe(1);
  });

  it("clears a stale detail from an earlier run when a new run starts", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    const stale = {
      preferredTime: "19:00",
      earliest: "18:00",
      latest: "20:00",
      matched: false,
      capturedAt: "2026-10-01T00:00:00.000Z",
      attempts: [
        {
          startedAt: "2026-10-01T00:00:00.000Z",
          durationMs: 10,
          acceptableSlots: 0,
          preferredSlots: 0,
          observedSlots: [observed({ localTime: "18:30" })],
        },
      ],
    };
    await seed(store, { availabilityDetail: stale });
    const challenge = new (await import("../src/opentable/errors.js"))
      .OpenTableAdapterError("AUTHENTICATION_REQUIRED", "sign-in required");
    const adapter = bookingAdapter({
      findSlotsDetailed: vi.fn().mockRejectedValue(challenge),
    });
    const engine = new ControlledBookingEngine(
      { adapter, store, notifier: recordingNotifier([]) },
      { execute: true },
    );

    await engine.runOnce("target-1");

    const record = await store.get("target-1");
    expect(record?.state).toBe("PAUSED");
    expect(record?.pauseReason).toContain("AUTHENTICATION_REQUIRED");
    expect(record?.availabilityDetail).toBeUndefined();
  });

  it("retries availability until the exact preferred time appears", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    await seed(store);
    const adapter = bookingAdapter({
      findSlotsDetailed: vi
        .fn<(target: BookingTarget) => Promise<DetailedAvailability>>()
        .mockResolvedValueOnce(detailed([makeSlot({ localTime: "18:30" })], [
          observed({ localTime: "18:30" }),
        ]))
        .mockResolvedValueOnce(detailed([makeSlot()], [observed()])),
    });
    const engine = new ControlledBookingEngine(
      { adapter, store, notifier: recordingNotifier([]) },
      {
        execute: true,
        availabilityAttempts: 2,
        availabilityRetryDelayMs: 1,
      },
    );

    await engine.runOnce("target-1");

    expect((await store.get("target-1"))?.state).toBe("BOOKED");
    expect(adapter.findSlotsDetailed).toHaveBeenCalledTimes(2);
    expect(
      (await store.get("target-1"))?.availabilityDetail?.attempts,
    ).toHaveLength(2);
  });

  it("pauses after exhausting availability retries", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    await seed(store);
    const adapter = bookingAdapter({
      findSlotsDetailed: vi
        .fn<(target: BookingTarget) => Promise<DetailedAvailability>>()
        .mockResolvedValue(
          detailed([makeSlot({ localTime: "18:30" })], [
            observed({ localTime: "18:30" }),
          ]),
        ),
    });
    const engine = new ControlledBookingEngine(
      { adapter, store, notifier: recordingNotifier([]) },
      {
        execute: true,
        availabilityAttempts: 3,
        availabilityRetryDelayMs: 1,
      },
    );

    await engine.runOnce("target-1");

    const record = await store.get("target-1");
    expect(record?.state).toBe("PAUSED");
    expect(record?.pauseReason).toContain("after 3 availability attempt(s)");
    expect(record?.availabilityDetail?.attempts).toHaveLength(3);
    expect(adapter.findSlotsDetailed).toHaveBeenCalledTimes(3);
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

  it("reads a callable booking mode when a console changes mode at runtime", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    await seed(store);
    const adapter = bookingAdapter();
    let execute = false;
    const engine = new ControlledBookingEngine(
      { adapter, store, notifier: recordingNotifier([]) },
      { execute: () => execute },
    );

    await engine.runOnce("target-1");
    expect((await store.get("target-1"))?.state).toBe("PAUSED");
    expect(adapter.authorizeBooking).not.toHaveBeenCalled();

    const paused = await store.get("target-1");
    if (paused === undefined) throw new Error("Target disappeared during mode test");
    await store.save({ ...paused, state: TargetState.ARMED }, paused.version);
    execute = true;
    await engine.runOnce("target-1");

    expect((await store.get("target-1"))?.state).toBe("BOOKED");
    expect(adapter.authorizeBooking).toHaveBeenCalledTimes(1);
  });

  it("pauses fail-closed when slot discovery fails", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    await seed(store);
    const adapter = bookingAdapter({
      findSlotsDetailed: vi.fn().mockRejectedValue(new Error("bridge unavailable")),
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
