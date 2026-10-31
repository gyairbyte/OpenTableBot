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
  DiningAreaDiscovery,
  DiscoverableSlot,
  LazyDiningAreaDiscovery,
  ObservationRecord,
  OpenTableBookingAdapter,
  PreparedBooking,
} from "../src/opentable/adapter.js";
import type { BookingTarget } from "../src/domain/booking-target.js";
import type {
  BookingPreview,
  ReservationSlot,
} from "../src/domain/reservation-slot.js";
import {
  RUNNABLE_TARGET_STATES,
  TargetState,
} from "../src/domain/target-state.js";
import {
  AdapterFailureCategory,
  OpenTableAdapterError,
} from "../src/opentable/errors.js";
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

async function seedWatcher(
  store: FileTargetStore,
  overrides: Partial<TargetRecord> = {},
): Promise<void> {
  await seed(store, {
    target: makeTarget({
      mode: "cancellation-watch",
      cancellationWatchStopAt: "2026-10-01T23:00:00.000Z",
    }),
    ...overrides,
  });
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

  describe("known drop with acceptAnyTimeInWindow", () => {
    function windowAdapter(slots: readonly ReservationSlot[], bookedId: string, bookedTime: string) {
      const preview = makePreview({ slotId: bookedId, localTime: bookedTime });
      return bookingAdapter({
        findSlotsDetailed: vi
          .fn<(target: BookingTarget) => Promise<DetailedAvailability>>()
          .mockResolvedValue(detailed(slots)),
        getBookingPreview: vi.fn().mockResolvedValue(preview),
        prepareBooking: vi.fn().mockResolvedValue({
          preview,
          bookingHandle: "00000000-0000-4000-8000-000000000010",
          expiresAt: "2099-01-01T00:00:00.000Z",
        }),
      });
    }

    async function seedWindowTarget(store: FileTargetStore): Promise<void> {
      await seed(store, {
        target: makeTarget({
          acceptAnyTimeInWindow: true,
          timeWindow: { earliest: "18:00", latest: "20:30", preferred: "19:00" },
        }),
      });
    }

    it("books the only open time in the window when the preferred time is absent", async () => {
      const store = new FileTargetStore({ directory: await tempDirectory() });
      await seedWindowTarget(store);
      const adapter = windowAdapter([makeSlot({ id: "late", localTime: "20:30" })], "late", "20:30");
      const engine = new ControlledBookingEngine(
        { adapter, store, notifier: recordingNotifier([]) },
        { execute: true },
      );

      await engine.runOnce("target-1");

      const record = await store.get("target-1");
      expect(record?.state).toBe(TargetState.BOOKED);
      expect(adapter.getBookingPreview).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: "late" }),
      );
      expect(record?.availabilityDetail?.matched).toBe(true);
      expect(record?.availabilityDetail?.attempts[0]?.preferredSlots).toBe(0);
    });

    it("still prefers the exact preferred time when it is open", async () => {
      const store = new FileTargetStore({ directory: await tempDirectory() });
      await seedWindowTarget(store);
      const adapter = windowAdapter(
        [
          makeSlot({ id: "late", localTime: "20:30" }),
          makeSlot({ id: "exact", localTime: "19:00" }),
          makeSlot({ id: "early", localTime: "18:00" }),
        ],
        "exact",
        "19:00",
      );
      const engine = new ControlledBookingEngine(
        { adapter, store, notifier: recordingNotifier([]) },
        { execute: true },
      );

      await engine.runOnce("target-1");

      expect((await store.get("target-1"))?.state).toBe(TargetState.BOOKED);
      expect(adapter.getBookingPreview).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: "exact" }),
      );
    });

    it("pauses with a window-based reason when nothing in the window is open", async () => {
      const store = new FileTargetStore({ directory: await tempDirectory() });
      await seedWindowTarget(store);
      const adapter = bookingAdapter({
        findSlotsDetailed: vi
          .fn<(target: BookingTarget) => Promise<DetailedAvailability>>()
          .mockResolvedValue(
            detailed([], [observed({ localTime: "22:30", withinWindow: false })]),
          ),
      });
      const engine = new ControlledBookingEngine(
        { adapter, store, notifier: recordingNotifier([]) },
        { execute: true },
      );

      await engine.runOnce("target-1");

      const record = await store.get("target-1");
      expect(record?.state).toBe(TargetState.PAUSED);
      expect(record?.pauseReason).toContain("No acceptable time in the 18:00-20:30 window");
      expect(adapter.authorizeBooking).not.toHaveBeenCalled();
    });
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

  it("keeps a cancellation watcher armed when the window holds no acceptable time", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    await seedWatcher(store);
    const adapter = bookingAdapter({
      findSlotsDetailed: vi
        .fn<(target: BookingTarget) => Promise<DetailedAvailability>>()
        .mockResolvedValue(
          detailed(
            [makeSlot({ localTime: "21:30" })],
            [observed({ localTime: "21:30", withinWindow: false })],
          ),
        ),
    });
    const engine = new ControlledBookingEngine(
      { adapter, store, notifier: recordingNotifier([]) },
      { execute: true },
    );

    await engine.runOnce("target-1");

    const record = await store.get("target-1");
    expect(record?.state).toBe(TargetState.ARMED);
    expect(record?.pauseReason).toBeUndefined();
    expect(record?.availabilityDetail?.matched).toBe(false);
    expect(adapter.authorizeBooking).not.toHaveBeenCalled();
  });

  it("books the acceptable cancellation-watch time closest to the preferred one", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    await seedWatcher(store);
    const closest = makePreview({ slotId: "closest", localTime: "19:15" });
    const adapter = bookingAdapter({
      findSlotsDetailed: vi
        .fn<(target: BookingTarget) => Promise<DetailedAvailability>>()
        .mockResolvedValue(
          detailed([
            makeSlot({ id: "earliest", localTime: "18:00" }),
            makeSlot({ id: "closest", localTime: "19:15" }),
          ]),
        ),
      getBookingPreview: vi.fn().mockResolvedValue(closest),
      prepareBooking: vi.fn().mockResolvedValue({
        preview: closest,
        bookingHandle: "00000000-0000-4000-8000-000000000010",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    });
    const engine = new ControlledBookingEngine(
      { adapter, store, notifier: recordingNotifier([]) },
      { execute: true },
    );

    await engine.runOnce("target-1");

    expect((await store.get("target-1"))?.state).toBe(TargetState.BOOKED);
    expect(adapter.getBookingPreview).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "closest" }),
    );
  });

  it("reads availability once per poll for a cancellation watcher", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    await seedWatcher(store);
    const adapter = bookingAdapter({
      findSlotsDetailed: vi
        .fn<(target: BookingTarget) => Promise<DetailedAvailability>>()
        .mockResolvedValue(detailed([])),
    });
    const engine = new ControlledBookingEngine(
      { adapter, store, notifier: recordingNotifier([]) },
      { execute: true, availabilityAttempts: 3, availabilityRetryDelayMs: 1 },
    );

    await engine.runOnce("target-1");

    expect(adapter.findSlotsDetailed).toHaveBeenCalledTimes(1);
  });

  it("keeps a cancellation watcher armed after a dry-run scan", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    await seedWatcher(store);
    const adapter = bookingAdapter();
    const engine = new ControlledBookingEngine(
      { adapter, store, notifier: recordingNotifier([]) },
      { execute: false },
    );

    await engine.runOnce("target-1");

    const record = await store.get("target-1");
    expect(record?.state).toBe(TargetState.ARMED);
    expect(record?.availabilityDetail?.matched).toBe(true);
    expect(adapter.authorizeBooking).not.toHaveBeenCalled();
    expect(adapter.book).not.toHaveBeenCalled();
  });

  it("resumes watching after a retryable failure while locking", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    await seedWatcher(store);
    const adapter = bookingAdapter({
      prepareBooking: vi.fn().mockRejectedValue(
        new OpenTableAdapterError(
          AdapterFailureCategory.LOCK_NOT_DISPATCHED,
          "the lock request never left the page",
        ),
      ),
    });
    const engine = new ControlledBookingEngine(
      { adapter, store, notifier: recordingNotifier([]) },
      { execute: true },
    );

    await engine.runOnce("target-1");

    const record = await store.get("target-1");
    expect(record?.state).toBe(TargetState.ARMED);
    expect(record?.pauseReason).toBeUndefined();
    // A stranded mid-flight state would silently drop the target out of the
    // scheduler's runnable set, ending the watch with no pause and no notice.
    expect(RUNNABLE_TARGET_STATES).toContain(record?.state);
    expect(adapter.book).not.toHaveBeenCalled();
  });

  it("pauses a cancellation watcher when a submission fails ambiguously", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    await seedWatcher(store);
    const adapter = bookingAdapter({
      book: vi.fn().mockRejectedValue(
        new OpenTableAdapterError(
          AdapterFailureCategory.TRANSIENT_TRANSPORT,
          "the bridge dropped mid-submit",
        ),
      ),
    });
    const engine = new ControlledBookingEngine(
      { adapter, store, notifier: recordingNotifier([]) },
      { execute: true },
    );

    await engine.runOnce("target-1");

    const record = await store.get("target-1");
    expect(record?.state).toBe(TargetState.PAUSED);
    expect(record?.pauseReason).toContain("TRANSIENT_TRANSPORT");
    expect(adapter.book).toHaveBeenCalledTimes(1);
  });

  it("resumes watching after a retryable availability failure", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    await seedWatcher(store);
    const adapter = bookingAdapter({
      findSlotsDetailed: vi.fn().mockRejectedValue(
        new OpenTableAdapterError(
          AdapterFailureCategory.RATE_LIMITED,
          "slow down",
        ),
      ),
    });
    const engine = new ControlledBookingEngine(
      { adapter, store, notifier: recordingNotifier([]) },
      { execute: true },
    );

    await engine.runOnce("target-1");

    expect((await store.get("target-1"))?.state).toBe(TargetState.ARMED);
  });

  it("keeps a watcher armed and records why when the browser page is not ready", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    await seedWatcher(store);
    const findSlotsDetailed = vi.fn().mockRejectedValue(
      new OpenTableAdapterError(
        AdapterFailureCategory.BROWSER_NOT_READY,
        "The RestaurantsAvailability operation has not been observed on this page",
      ),
    );
    const adapter = bookingAdapter({ findSlotsDetailed });
    const engine = new ControlledBookingEngine(
      { adapter, store, notifier: recordingNotifier([]) },
      { execute: true },
    );

    await engine.runOnce("target-1");

    const record = await store.get("target-1");
    expect(record?.state).toBe(TargetState.ARMED);
    expect(record?.scanBlockedReason).toContain("BROWSER_NOT_READY");
    expect(record?.scanBlockedReason).toContain("has not been observed");

    // The next run that can scan clears the reason.
    findSlotsDetailed.mockResolvedValue(detailed([]));
    await engine.runOnce("target-1");
    const recovered = await store.get("target-1");
    expect(recovered?.state).toBe(TargetState.ARMED);
    expect(recovered?.scanBlockedReason).toBeUndefined();
  });

  it("does not call a vanished slot a blind scan", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    await seedWatcher(store);
    const adapter = bookingAdapter({
      prepareBooking: vi.fn().mockRejectedValue(
        new OpenTableAdapterError(
          AdapterFailureCategory.SLOT_DISAPPEARED,
          "someone else took it",
        ),
      ),
    });
    const engine = new ControlledBookingEngine(
      { adapter, store, notifier: recordingNotifier([]) },
      { execute: true },
    );

    await engine.runOnce("target-1");

    const record = await store.get("target-1");
    expect(record?.state).toBe(TargetState.ARMED);
    expect(record?.scanBlockedReason).toBeUndefined();
  });

  it("still pauses a known-drop target when the browser page is not ready", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    await seed(store);
    const adapter = bookingAdapter({
      findSlotsDetailed: vi.fn().mockRejectedValue(
        new OpenTableAdapterError(AdapterFailureCategory.BROWSER_NOT_READY, "no page"),
      ),
    });
    const engine = new ControlledBookingEngine(
      { adapter, store, notifier: recordingNotifier([]) },
      { execute: true },
    );

    await engine.runOnce("target-1");

    expect((await store.get("target-1"))?.state).toBe(TargetState.PAUSED);
  });

  it("pauses a cancellation watcher on a failure that needs a human", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    await seedWatcher(store);
    const adapter = bookingAdapter({
      findSlotsDetailed: vi.fn().mockRejectedValue(
        new OpenTableAdapterError(
          AdapterFailureCategory.AUTHENTICATION_REQUIRED,
          "sign-in required",
        ),
      ),
    });
    const engine = new ControlledBookingEngine(
      { adapter, store, notifier: recordingNotifier([]) },
      { execute: true },
    );

    await engine.runOnce("target-1");

    const record = await store.get("target-1");
    expect(record?.state).toBe(TargetState.PAUSED);
    expect(record?.pauseReason).toContain("AUTHENTICATION_REQUIRED");
  });

  it("still pauses a known-drop target when a retryable failure interrupts locking", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    await seed(store);
    const adapter = bookingAdapter({
      prepareBooking: vi.fn().mockRejectedValue(
        new OpenTableAdapterError(
          AdapterFailureCategory.LOCK_NOT_DISPATCHED,
          "the lock request never left the page",
        ),
      ),
    });
    const engine = new ControlledBookingEngine(
      { adapter, store, notifier: recordingNotifier([]) },
      { execute: true },
    );

    await engine.runOnce("target-1");

    const record = await store.get("target-1");
    expect(record?.state).toBe(TargetState.PAUSED);
    expect(record?.pauseReason).toContain("LOCK_NOT_DISPATCHED");
  });

  describe("trying the next-ranked candidate", () => {
    function windowTarget(): BookingTarget {
      return makeTarget({
        acceptAnyTimeInWindow: true,
        timeWindow: { earliest: "18:00", latest: "20:00", preferred: "19:00" },
      });
    }

    function slotAt(time: string): ReservationSlot {
      return makeSlot({
        id: `slot-${time}`,
        localTime: time,
        startsAt: `2026-09-01T${time}:00-04:00`,
      });
    }

    function previewFor(slot: ReservationSlot): BookingPreview {
      return makePreview({ slotId: slot.id, localTime: slot.localTime });
    }

    function preparedFor(slot: ReservationSlot): PreparedBooking {
      return {
        preview: previewFor(slot),
        bookingHandle: "00000000-0000-4000-8000-000000000010",
        expiresAt: "2099-01-01T00:00:00.000Z",
      };
    }

    const vanished = (): OpenTableAdapterError =>
      new OpenTableAdapterError(
        AdapterFailureCategory.SLOT_DISAPPEARED,
        "the table has been taken",
      );

    function adapterFor(
      slots: readonly ReservationSlot[],
      overrides: Partial<OpenTableBookingAdapter> = {},
    ): OpenTableBookingAdapter {
      return bookingAdapter({
        findSlotsDetailed: vi
          .fn<(target: BookingTarget) => Promise<DetailedAvailability>>()
          .mockResolvedValue(detailed(slots)),
        getBookingPreview: vi.fn(
          async (_target: BookingTarget, slot: ReservationSlot) => previewFor(slot),
        ),
        prepareBooking: vi.fn(
          async (
            _target: BookingTarget,
            slot: ReservationSlot,
          ): Promise<PreparedBooking> => preparedFor(slot),
        ),
        ...overrides,
      });
    }

    async function run(
      adapter: OpenTableBookingAdapter,
      events: Notification[] = [],
    ): Promise<{ record: TargetRecord | undefined }> {
      const store = new FileTargetStore({ directory: await tempDirectory() });
      await seed(store, { target: windowTarget() });
      const engine = new ControlledBookingEngine(
        { adapter, store, notifier: recordingNotifier(events) },
        { execute: true },
      );
      await engine.runOnce("target-1");
      return { record: await store.get("target-1") };
    }

    it("moves on when the best table has vanished before locking", async () => {
      const best = slotAt("19:00");
      const next = slotAt("19:15");
      const adapter = adapterFor([next, best], {
        getBookingPreview: vi.fn(
          async (_target: BookingTarget, slot: ReservationSlot) => {
            if (slot.id === best.id) throw vanished();
            return previewFor(slot);
          },
        ),
      });

      const { record } = await run(adapter);

      expect(record?.state).toBe(TargetState.BOOKED);
      expect(adapter.authorizeBooking).toHaveBeenCalledTimes(1);
      expect(adapter.authorizeBooking).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: next.id }),
        expect.anything(),
      );
    });

    it("moves on when the provider refuses the lock, through the defined states", async () => {
      const best = slotAt("19:00");
      const next = slotAt("19:15");
      const events: Notification[] = [];
      const adapter = adapterFor([best, next], {
        prepareBooking: vi.fn(
          async (
            _target: BookingTarget,
            slot: ReservationSlot,
          ): Promise<PreparedBooking> => {
            if (slot.id === best.id) {
              throw new OpenTableAdapterError(
                AdapterFailureCategory.LOCK_REJECTED,
                "the provider refused the lock",
              );
            }
            return preparedFor(slot);
          },
        ),
      });

      const { record } = await run(adapter, events);

      expect(record?.state).toBe(TargetState.BOOKED);
      expect(adapter.book).toHaveBeenCalledTimes(1);
      const transitions = events.flatMap((event) =>
        event.type === "state-changed" ? [`${event.from}>${event.to}`] : [],
      );
      expect(transitions).toEqual([
        "ARMED>WAITING",
        "WAITING>MATCH_FOUND",
        "MATCH_FOUND>VALIDATING",
        "VALIDATING>LOCKING",
        "LOCKING>SLOT_LOST",
        "SLOT_LOST>WAITING",
        "WAITING>MATCH_FOUND",
        "MATCH_FOUND>VALIDATING",
        "VALIDATING>LOCKING",
        "LOCKING>LOCKED",
        "LOCKED>REVALIDATING",
        "REVALIDATING>SUBMITTING",
        "SUBMITTING>BOOKED",
      ]);
    });

    it("does not move on after a lock whose outcome is unknown", async () => {
      const adapter = adapterFor([slotAt("19:00"), slotAt("19:15")], {
        prepareBooking: vi.fn().mockRejectedValue(
          new OpenTableAdapterError(
            AdapterFailureCategory.LOCK_OUTCOME_UNKNOWN,
            "the bridge dropped after dispatch",
          ),
        ),
      });

      const { record } = await run(adapter);

      expect(record?.state).toBe(TargetState.PAUSED);
      expect(record?.pauseReason).toContain("LOCK_OUTCOME_UNKNOWN");
      expect(adapter.authorizeBooking).toHaveBeenCalledTimes(1);
      expect(adapter.prepareBooking).toHaveBeenCalledTimes(1);
    });

    it("never books a second table after a submission outcome is unknown", async () => {
      const adapter = adapterFor([slotAt("19:00"), slotAt("19:15")], {
        book: vi.fn().mockResolvedValue({
          status: "outcome-unknown",
          message: "the submission could not be confirmed",
        } satisfies BookingSubmissionResult),
      });

      const { record } = await run(adapter);

      expect(record?.state).toBe(TargetState.OUTCOME_UNKNOWN);
      expect(adapter.prepareBooking).toHaveBeenCalledTimes(1);
      expect(adapter.book).toHaveBeenCalledTimes(1);
    });

    it("does not move on from a booking-policy rejection", async () => {
      const adapter = adapterFor([slotAt("19:00"), slotAt("19:15")], {
        getBookingPreview: vi.fn(
          async (_target: BookingTarget, slot: ReservationSlot) =>
            makePreview({ slotId: slot.id, localTime: slot.localTime, isAmbiguous: true }),
        ),
      });

      const { record } = await run(adapter);

      expect(record?.state).toBe(TargetState.PAUSED);
      expect(record?.pauseReason).toContain("POLICY_REJECTED");
      expect(adapter.getBookingPreview).toHaveBeenCalledTimes(1);
    });

    it("pauses and says how many candidates were tried when all are gone", async () => {
      const adapter = adapterFor(
        [slotAt("19:00"), slotAt("19:15"), slotAt("19:30")],
        { getBookingPreview: vi.fn().mockRejectedValue(vanished()) },
      );

      const { record } = await run(adapter);

      expect(record?.state).toBe(TargetState.PAUSED);
      expect(record?.pauseReason).toContain("SLOT_DISAPPEARED");
      expect(record?.pauseReason).toContain("after trying 3 candidate times");
      expect(adapter.authorizeBooking).not.toHaveBeenCalled();
    });

    it("stops after five candidates rather than working through every time", async () => {
      const adapter = adapterFor(
        ["18:00", "18:15", "18:30", "18:45", "19:00", "19:15", "19:30"].map(slotAt),
        { getBookingPreview: vi.fn().mockRejectedValue(vanished()) },
      );

      const { record } = await run(adapter);

      expect(record?.state).toBe(TargetState.PAUSED);
      expect(adapter.getBookingPreview).toHaveBeenCalledTimes(5);
      expect(record?.pauseReason).toContain("after trying 5 candidate times");
    });

    describe("with lazy dining-area discovery", () => {
      function lazyAdapterFor(
        times: readonly string[],
        overrides: Partial<OpenTableBookingAdapter> = {},
      ): {
        readonly adapter: OpenTableBookingAdapter & LazyDiningAreaDiscovery;
        readonly discover: ReturnType<typeof vi.fn>;
      } {
        const candidates: DiscoverableSlot[] = times.map((time) => {
          const observation: ObservationRecord = {
            ...observed({ localTime: time }),
            diningAreas: [],
          };
          return {
            slot: makeSlot({ id: `base-${time}`, localTime: time }),
            observation,
          };
        });
        const discover = vi.fn(
          async (
            _target: BookingTarget,
            candidate: DiscoverableSlot,
          ): Promise<DiningAreaDiscovery> => {
            candidate.observation.diningAreas.push("Dining Room");
            return { slots: [slotAt(candidate.slot.localTime)] };
          },
        );
        const lazy: LazyDiningAreaDiscovery = {
          findBaseSlots: vi.fn(async () => ({
            candidates,
            observedSlots: candidates.map((candidate) => candidate.observation),
          })),
          discoverDiningAreas: discover,
        };
        const adapter = Object.assign(
          adapterFor([], {
            findSlotsDetailed: vi.fn().mockRejectedValue(new Error("eager lookup used")),
            ...overrides,
          }),
          lazy,
        );
        return { adapter, discover };
      }

      it("looks up only the best time's dining area when it books", async () => {
        const { adapter, discover } = lazyAdapterFor(["20:00", "19:15", "19:00"]);

        const { record } = await run(adapter);

        expect(record?.state).toBe(TargetState.BOOKED);
        expect(discover).toHaveBeenCalledTimes(1);
        expect(discover.mock.calls[0]?.[1]).toMatchObject({
          slot: { localTime: "19:00" },
        });
        const detail = record?.availabilityDetail?.attempts[0]?.observedSlots ?? [];
        const byTime = new Map(detail.map((slot) => [slot.localTime, slot]));
        expect(byTime.get("19:00")?.diningAreas).toEqual(["Dining Room"]);
        expect(byTime.get("19:15")?.diningAreaIssue).toContain("Not checked");
        expect(byTime.get("20:00")?.diningAreaIssue).toContain("Not checked");
      });

      it("looks up the next time only once the best one is gone", async () => {
        const { adapter, discover } = lazyAdapterFor(["20:00", "19:15", "19:00"], {
          getBookingPreview: vi.fn(
            async (_target: BookingTarget, slot: ReservationSlot) => {
              if (slot.localTime === "19:00") throw vanished();
              return previewFor(slot);
            },
          ),
        });

        const { record } = await run(adapter);

        expect(record?.state).toBe(TargetState.BOOKED);
        expect(
          discover.mock.calls.map((call) => (call[1] as DiscoverableSlot).slot.localTime),
        ).toEqual(["19:00", "19:15"]);
        expect(adapter.authorizeBooking).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ localTime: "19:15" }),
          expect.anything(),
        );
      });
    });
  });
});
