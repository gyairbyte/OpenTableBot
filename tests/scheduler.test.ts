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
});
