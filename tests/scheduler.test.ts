import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TargetState } from "../src/domain/target-state.js";
import { FileTargetStore } from "../src/storage/file-target-store.js";
import type { TargetRecord } from "../src/storage/target-store.js";
import { ReservationScheduler } from "../src/runner/scheduler.js";
import { makeTarget } from "./fixtures.js";

async function tempDirectory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "otb-sched-"));
}

function record(releaseAt: string): TargetRecord {
  return {
    target: makeTarget({ knownReservationReleaseAt: releaseAt }),
    state: TargetState.ARMED,
    version: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

describe("ReservationScheduler", () => {
  it("does nothing before the warm-up window opens", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    const runOnce = vi.fn().mockResolvedValue(undefined);
    const checkAuthentication = vi
      .fn()
      .mockResolvedValue({ authenticated: true });
    const scheduler = new ReservationScheduler(
      { runOnce },
      { checkAuthentication },
      store,
      { notify: vi.fn().mockResolvedValue(undefined) },
      {
        now: () => Date.parse("2026-10-01T11:00:00.000Z"),
        sleep: async () => undefined,
      },
    );

    await scheduler.runTarget(record("2026-10-01T12:00:00.000Z"));

    expect(runOnce).not.toHaveBeenCalled();
    expect(checkAuthentication).not.toHaveBeenCalled();
  });

  it("waits for the drop and runs once when the page is ready", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    let current = Date.parse("2026-10-01T11:59:30.000Z");
    const runOnce = vi.fn().mockResolvedValue(undefined);
    const sleeps: number[] = [];
    const scheduler = new ReservationScheduler(
      { runOnce },
      { checkAuthentication: vi.fn().mockResolvedValue({ authenticated: true }) },
      store,
      { notify: vi.fn().mockResolvedValue(undefined) },
      {
        now: () => current,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
          current += milliseconds;
        },
      },
    );

    await scheduler.runTarget(record("2026-10-01T12:00:00.000Z"));

    expect(runOnce).toHaveBeenCalledWith("target-1");
    expect(sleeps).toContain(30_000);
  });

  it("keeps polling for readiness while unauthenticated, then attempts once", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    let current = Date.parse("2026-10-01T11:59:30.000Z");
    const runOnce = vi.fn().mockResolvedValue(undefined);
    const checkAuthentication = vi
      .fn()
      .mockResolvedValue({ authenticated: false, reason: "required" });
    const scheduler = new ReservationScheduler(
      { runOnce },
      { checkAuthentication },
      store,
      { notify: vi.fn().mockResolvedValue(undefined) },
      {
        now: () => current,
        sleep: async (milliseconds) => {
          current += milliseconds;
        },
      },
    );

    await scheduler.runTarget(record("2026-10-01T12:00:00.000Z"));

    expect(checkAuthentication.mock.calls.length).toBeGreaterThan(1);
    expect(runOnce).toHaveBeenCalledTimes(1);
  });

  it("runs immediately without warm-up once the release time has passed", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    const runOnce = vi.fn().mockResolvedValue(undefined);
    const checkAuthentication = vi
      .fn()
      .mockResolvedValue({ authenticated: true });
    const scheduler = new ReservationScheduler(
      { runOnce },
      { checkAuthentication },
      store,
      { notify: vi.fn().mockResolvedValue(undefined) },
      { now: () => Date.parse("2026-10-01T12:00:05.000Z") },
    );

    await scheduler.runTarget(record("2026-10-01T12:00:00.000Z"));

    expect(runOnce).toHaveBeenCalledWith("target-1");
    expect(checkAuthentication).not.toHaveBeenCalled();
  });

  // A drop can trigger on a machine that just resumed. If Chrome and the
  // extension never came up, the run must not start against a dead page.
  it("pauses instead of running when the browser is not ready at the release time", async () => {
    const directory = await tempDirectory();
    const store = new FileTargetStore({ directory });
    const stored = await store.save(record("2026-10-01T12:00:00.000Z"), 0);

    const runOnce = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn().mockResolvedValue(undefined);
    const scheduler = new ReservationScheduler(
      { runOnce },
      { checkAuthentication: vi.fn().mockResolvedValue({ authenticated: true }) },
      store,
      { notify },
      {
        now: () => Date.parse("2026-10-01T12:00:00.000Z"),
        readiness: async () => ({
          ready: false,
          detail: "extension not connected, no eligible OpenTable page",
        }),
      },
    );

    await scheduler.runTarget(stored);

    expect(runOnce).not.toHaveBeenCalled();
    const saved = await store.get("target-1");
    expect(saved?.state).toBe(TargetState.PAUSED);
    expect(saved?.pauseReason).toContain("Browser was not ready at the release time");
    expect(saved?.pauseReason).toContain("extension not connected");
    expect(notify).toHaveBeenCalledWith({
      type: "target-paused",
      targetId: "target-1",
      reason: expect.stringContaining("Browser was not ready"),
    });
  });

  it("runs once when the browser is ready at the release time", async () => {
    const directory = await tempDirectory();
    const store = new FileTargetStore({ directory });
    const stored = await store.save(record("2026-10-01T12:00:00.000Z"), 0);

    const runOnce = vi.fn().mockResolvedValue(undefined);
    const scheduler = new ReservationScheduler(
      { runOnce },
      { checkAuthentication: vi.fn().mockResolvedValue({ authenticated: true }) },
      store,
      { notify: vi.fn().mockResolvedValue(undefined) },
      {
        now: () => Date.parse("2026-10-01T12:00:00.000Z"),
        readiness: async () => ({ ready: true, detail: "extension connected" }),
      },
    );

    await scheduler.runTarget(stored);

    expect(runOnce).toHaveBeenCalledWith("target-1");
  });

  it("waits through the warm-up window for a late browser", async () => {
    const directory = await tempDirectory();
    const store = new FileTargetStore({ directory });
    const stored = await store.save(record("2026-10-01T12:00:00.000Z"), 0);

    let current = Date.parse("2026-10-01T11:59:00.000Z");
    let ready = false;
    const runOnce = vi.fn().mockResolvedValue(undefined);
    const scheduler = new ReservationScheduler(
      { runOnce },
      { checkAuthentication: vi.fn().mockResolvedValue({ authenticated: true }) },
      store,
      { notify: vi.fn().mockResolvedValue(undefined) },
      {
        now: () => current,
        sleep: async (milliseconds) => {
          current += milliseconds;
          // Chrome finishes loading 20 seconds before the drop.
          if (current >= Date.parse("2026-10-01T11:59:40.000Z")) ready = true;
        },
        readiness: async () =>
          ready
            ? { ready: true, detail: "extension connected" }
            : { ready: false, detail: "extension not connected" },
      },
    );

    await scheduler.runTarget(stored);

    expect(runOnce).toHaveBeenCalledWith("target-1");
    expect((await store.get("target-1"))?.state).toBe(TargetState.ARMED);
  });

  it("polls cancellation-watch targets at the configured interval", async () => {
    const directory = await tempDirectory();
    const store = new FileTargetStore({ directory });
    const target = makeTarget({
      mode: "cancellation-watch",
      dateRange: { startDate: "2026-10-02", endDate: "2026-10-02" },
      cancellationWatchStopAt: "2026-10-01T13:00:00.000Z",
    });
    const stored = await store.save(
      { target, state: TargetState.ARMED, version: 0, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" },
      0,
    );
    let current = Date.parse("2026-10-01T12:00:00.000Z");
    const runOnce = vi.fn().mockResolvedValue(undefined);
    const scheduler = new ReservationScheduler(
      { runOnce },
      { checkAuthentication: vi.fn().mockResolvedValue({ authenticated: true }) },
      store,
      { notify: vi.fn().mockResolvedValue(undefined) },
      {
        now: () => current,
        readiness: async () => ({ ready: true, detail: "ready" }),
        cancellationWatchPollMs: 30_000,
      },
    );

    await scheduler.runTarget(stored);
    await scheduler.runTarget(stored);
    current += 30_000;
    await scheduler.runTarget(stored);

    expect(runOnce).toHaveBeenCalledTimes(2);
  });

  it("pauses a cancellation watcher at its configured stop time", async () => {
    const directory = await tempDirectory();
    const store = new FileTargetStore({ directory });
    const stored = await store.save(
      {
        target: makeTarget({
          mode: "cancellation-watch",
          cancellationWatchStopAt: "2026-10-01T12:00:00.000Z",
        }),
        state: TargetState.ARMED,
        version: 0,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
      0,
    );
    const scheduler = new ReservationScheduler(
      { runOnce: vi.fn() },
      { checkAuthentication: vi.fn().mockResolvedValue({ authenticated: true }) },
      store,
      { notify: vi.fn().mockResolvedValue(undefined) },
      { now: () => Date.parse("2026-10-01T12:00:01.000Z") },
    );

    await scheduler.runTarget(stored);

    expect((await store.get("target-1"))?.state).toBe(TargetState.PAUSED);
  });

  it("leaves a cancellation watcher armed when readiness is temporarily unavailable", async () => {
    const directory = await tempDirectory();
    const store = new FileTargetStore({ directory });
    const stored = await store.save(
      {
        target: makeTarget({
          mode: "cancellation-watch",
          dateRange: { startDate: "2026-10-02", endDate: "2026-10-02" },
          cancellationWatchStopAt: "2026-10-01T13:00:00.000Z",
        }),
        state: TargetState.ARMED,
        version: 0,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
      0,
    );
    const scheduler = new ReservationScheduler(
      { runOnce: vi.fn() },
      { checkAuthentication: vi.fn().mockResolvedValue({ authenticated: false }) },
      store,
      { notify: vi.fn().mockResolvedValue(undefined) },
      {
        now: () => Date.parse("2026-10-01T12:00:00.000Z"),
        readiness: async () => ({ ready: false, detail: "session not authenticated" }),
      },
    );

    await scheduler.runTarget(stored);

    expect((await store.get("target-1"))?.state).toBe(TargetState.ARMED);
  });

  describe("watcher blind alert", () => {
    async function watcherSetup(
      runOnce: (id: string, store: FileTargetStore) => Promise<void>,
      readiness: () => Promise<{ ready: boolean; detail: string }>,
    ) {
      const store = new FileTargetStore({ directory: await tempDirectory() });
      const stored = await store.save(
        {
          target: makeTarget({
            mode: "cancellation-watch",
            dateRange: { startDate: "2026-10-02", endDate: "2026-10-02" },
            cancellationWatchStopAt: "2026-10-01T23:00:00.000Z",
          }),
          state: TargetState.ARMED,
          version: 0,
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z",
        },
        0,
      );
      let current = Date.parse("2026-10-01T12:00:00.000Z");
      const notify = vi.fn().mockResolvedValue(undefined);
      const scheduler = new ReservationScheduler(
        { runOnce: (id) => runOnce(id, store) },
        { checkAuthentication: vi.fn() },
        store,
        { notify },
        {
          now: () => current,
          readiness,
          cancellationWatchPollMs: 30_000,
          watcherBlindAlertMs: 600_000,
        },
      );
      return {
        stored,
        notify,
        scheduler,
        advance: (ms: number) => {
          current += ms;
        },
      };
    }

    it("alerts once the browser has been unready past the threshold, then recovers", async () => {
      let ready = false;
      const runOnce = vi.fn().mockResolvedValue(undefined);
      const { stored, notify, scheduler, advance } = await watcherSetup(runOnce, async () => ({
        ready,
        detail: "no eligible OpenTable page",
      }));

      await scheduler.runTarget(stored);
      advance(300_000);
      await scheduler.runTarget(stored);
      expect(notify).not.toHaveBeenCalled();

      advance(300_000);
      await scheduler.runTarget(stored);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenLastCalledWith({
        type: "watcher-blind",
        targetId: "target-1",
        reason: "Browser not ready (no eligible OpenTable page)",
        blindForMs: 600_000,
      });

      // No repeat inside the same alert interval.
      advance(60_000);
      await scheduler.runTarget(stored);
      expect(notify).toHaveBeenCalledTimes(1);

      ready = true;
      advance(30_000);
      await scheduler.runTarget(stored);
      expect(runOnce).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenLastCalledWith({
        type: "watcher-recovered",
        targetId: "target-1",
        blindForMs: 690_000,
      });
    });

    it("alerts when polls run but the engine keeps failing to scan", async () => {
      const { stored, notify, scheduler, advance } = await watcherSetup(
        // Emulates the engine resuming a watch it could not scan.
        async (id, store) => {
          const current = await store.get(id);
          if (current === undefined) throw new Error("missing");
          await store.save(
            { ...current, scanBlockedReason: "BROWSER_NOT_READY: not observed" },
            current.version,
          );
        },
        async () => ({ ready: true, detail: "ready" }),
      );

      for (let poll = 0; poll <= 20; poll += 1) {
        await scheduler.runTarget(stored);
        advance(30_000);
      }

      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "watcher-blind",
          reason: "BROWSER_NOT_READY: not observed",
        }),
      );
    });

    it("does not alert for a healthy watcher", async () => {
      const { stored, notify, scheduler, advance } = await watcherSetup(
        async () => undefined,
        async () => ({ ready: true, detail: "ready" }),
      );

      for (let poll = 0; poll < 30; poll += 1) {
        await scheduler.runTarget(stored);
        advance(30_000);
      }

      expect(notify).not.toHaveBeenCalled();
    });
  });
});
