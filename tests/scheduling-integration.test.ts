import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DetailedAvailability } from "../src/domain/availability-detail.js";
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
import {
  AdapterFailureCategory,
  OpenTableAdapterError,
} from "../src/opentable/errors.js";
import { LocalNotifier, notificationLogPath } from "../src/notifications/local-notifier.js";
import { ControlledBookingEngine } from "../src/runner/controlled-booking-engine.js";
import { ReservationScheduler } from "../src/runner/scheduler.js";
import { FileTargetStore } from "../src/storage/file-target-store.js";
import { makePreview, makeSlot, makeTarget } from "./fixtures.js";

const RELEASE = "2026-11-08T10:00:00-05:00";
const RELEASE_MS = Date.parse(RELEASE);

function fakeAdapter(
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
      confirmationId: "confirmation-live-1",
      slotId: "slot-1",
      restaurantId: "restaurant-123",
      startsAt: "2026-09-01T19:00:00-04:00",
      partySize: 2,
      seatingType: "standard",
      bookedAt: "2026-10-09T12:00:00.000Z",
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
      .mockResolvedValue({ acceptableSlots: [makeSlot()], observedSlots: [] }),
    getBookingPreview: vi
      .fn<(target: BookingTarget, slot: ReservationSlot) => Promise<BookingPreview>>()
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

/** Wires the real store, notifier, engine, and scheduler with a controllable clock. */
async function harness(adapter: OpenTableBookingAdapter) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "otb-e2e-"));
  const store = new FileTargetStore({
    directory,
    now: () => new Date("2026-10-09T12:00:00.000Z"),
  });
  const printed: string[] = [];
  const notifier = new LocalNotifier({
    directory,
    write: (line) => printed.push(line),
    now: () => new Date("2026-10-09T12:00:00.000Z"),
  });
  let current = RELEASE_MS - 30_000;
  const scheduler = new ReservationScheduler(
    new ControlledBookingEngine({ adapter, store, notifier }, { execute: true }),
    adapter,
    store,
    notifier,
    {
      now: () => current,
      sleep: async (milliseconds) => {
        current += milliseconds;
      },
    },
  );
  await store.save(
    {
      target: makeTarget({
        id: "don-angie",
        knownReservationReleaseAt: RELEASE,
        dateRange: { startDate: "2026-09-01", endDate: "2026-09-01" },
      }),
      state: TargetState.ARMED,
      version: 0,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    },
    0,
  );
  return { directory, store, notifier, scheduler, printed };
}

describe("known-drop scheduling end to end", () => {
  it("books the exact preferred time and logs the confirmation", async () => {
    const adapter = fakeAdapter();
    const { directory, store, scheduler } = await harness(adapter);

    await scheduler.runDueTargets();

    const record = await store.get("don-angie");
    expect(record?.state).toBe("BOOKED");
    expect(record?.confirmation?.confirmationId).toBe("confirmation-live-1");
    expect(adapter.book).toHaveBeenCalledTimes(1);
    expect(adapter.authorizeBooking).toHaveBeenCalledTimes(1);

    const log = await readFile(notificationLogPath(directory), "utf8");
    const types = log
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(types).toContain("booking-confirmed");
  });

  it("walks the documented state sequence through a successful booking", async () => {
    const adapter = fakeAdapter();
    const { store, scheduler } = await harness(adapter);

    await scheduler.runDueTargets();

    const states = (await store.list()).map((record) => record.state);
    expect(states).toEqual(["BOOKED"]);
  });

  it("pauses without booking when the exact preferred time is absent", async () => {
    const adapter = fakeAdapter({
      findSlotsDetailed: vi.fn().mockResolvedValue({
        acceptableSlots: [makeSlot({ localTime: "18:30" })],
        observedSlots: [],
      }),
    });
    const { store, scheduler } = await harness(adapter);

    await scheduler.runDueTargets();

    const record = await store.get("don-angie");
    expect(record?.state).toBe("PAUSED");
    expect(record?.pauseReason).toContain("preferred");
    expect(record?.availabilityDetail?.matched).toBe(false);
    expect(adapter.book).not.toHaveBeenCalled();
  });

  it("pauses fail-closed when the page reports a challenge", async () => {
    const challenge = new OpenTableAdapterError(
      AdapterFailureCategory.CAPTCHA_OR_CHALLENGE,
      "OpenTable presented a challenge",
    );
    const adapter = fakeAdapter({
      checkAuthentication: vi.fn().mockRejectedValue(challenge),
      findSlotsDetailed: vi.fn().mockRejectedValue(challenge),
    });
    const { store, scheduler } = await harness(adapter);

    await scheduler.runDueTargets();

    const record = await store.get("don-angie");
    expect(record?.state).toBe("PAUSED");
    expect(record?.pauseReason).toContain("CAPTCHA_OR_CHALLENGE");
    expect(adapter.book).not.toHaveBeenCalled();
  });
});
