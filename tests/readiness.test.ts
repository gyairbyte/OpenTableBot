import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Pong } from "../src/opentable/bridge/protocol.js";
import {
  describeReadiness,
  waitForBridgeReadiness,
} from "../src/opentable/bridge/readiness.js";

function pong(overrides: Partial<Pong> = {}): Pong {
  return {
    protocolVersion: 1,
    id: "00000000-0000-4000-8000-000000000001",
    type: "PONG",
    extensionConnected: true,
    pageReady: true,
    ...overrides,
  } as Pong;
}

describe("waitForBridgeReadiness", () => {
  it("returns immediately when the extension and a page are ready", async () => {
    const ping = vi.fn().mockResolvedValue(pong({ pageUrl: "https://www.opentable.com/r/x" }));
    const report = await waitForBridgeReadiness({ ping, timeoutMs: 0 });

    expect(report.ready).toBe(true);
    expect(report.attempts).toBe(1);
    expect(report.pageUrl).toBe("https://www.opentable.com/r/x");
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it("keeps polling until the page becomes eligible", async () => {
    let current = 0;
    const ping = vi
      .fn()
      .mockResolvedValueOnce(pong({ pageReady: false }))
      .mockResolvedValueOnce(pong({ extensionConnected: false, pageReady: false }))
      .mockResolvedValue(pong());
    const progress: string[] = [];

    const report = await waitForBridgeReadiness({
      ping,
      timeoutMs: 60_000,
      intervalMs: 3_000,
      now: () => current,
      sleep: async (milliseconds) => {
        current += milliseconds;
      },
      onProgress: (message) => progress.push(message),
    });

    expect(report.ready).toBe(true);
    expect(report.attempts).toBe(3);
    // Only genuine state changes are reported, not every poll.
    expect(progress).toEqual([
      "extension connected, no eligible OpenTable page",
      "extension not connected, no eligible OpenTable page",
      "extension connected, OpenTable page ready",
    ]);
  });

  it("gives up at the deadline and reports the last observation", async () => {
    let current = 0;
    const report = await waitForBridgeReadiness({
      ping: vi.fn().mockResolvedValue(pong({ pageReady: false })),
      timeoutMs: 10_000,
      intervalMs: 3_000,
      now: () => current,
      sleep: async (milliseconds) => {
        current += milliseconds;
      },
    });

    expect(report.ready).toBe(false);
    expect(report.extensionConnected).toBe(true);
    expect(report.pageReady).toBe(false);
    expect(describeReadiness(report)).toContain("no eligible OpenTable page");
  });

  it("retries an unreachable bridge instead of throwing", async () => {
    let current = 0;
    const ping = vi
      .fn()
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:38471"))
      .mockResolvedValue(pong());

    const report = await waitForBridgeReadiness({
      ping,
      timeoutMs: 30_000,
      intervalMs: 3_000,
      now: () => current,
      sleep: async (milliseconds) => {
        current += milliseconds;
      },
    });

    expect(report.ready).toBe(true);
    expect(report.attempts).toBe(2);
  });

  it("reports the bridge error when it never becomes reachable", async () => {
    const report = await waitForBridgeReadiness({
      ping: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      timeoutMs: 0,
    });

    expect(report.ready).toBe(false);
    expect(report.lastError).toContain("ECONNREFUSED");
    expect(describeReadiness(report)).toContain("bridge unreachable");
  });
});

describe("scheduler lock", () => {
  async function tempDirectory(): Promise<string> {
    return mkdtemp(path.join(os.tmpdir(), "otb-lock-"));
  }

  it("acquires and releases the lock", async () => {
    const { acquireSchedulerLock, releaseSchedulerLock, readSchedulerLock } =
      await import("../src/storage/scheduler-lock.js");
    const directory = await tempDirectory();

    const lock = await acquireSchedulerLock(directory, "schedule-cli test");
    expect("heldBy" in lock).toBe(false);
    if ("heldBy" in lock) return;

    const held = await readSchedulerLock(directory);
    expect(held?.owner).toBe("schedule-cli test");
    expect(held?.pid).toBe(process.pid);

    await releaseSchedulerLock(lock);
    expect(await readSchedulerLock(directory)).toBeUndefined();
  });

  it("reports a conflict when another live process holds the lock", async () => {
    const { acquireSchedulerLock, readSchedulerLock, schedulerLockPath } =
      await import("../src/storage/scheduler-lock.js");
    const directory = await tempDirectory();
    // A real, live process that is not this one, so liveness is genuine.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      stdio: "ignore",
    });
    try {
      await writeFile(
        schedulerLockPath(directory),
        `${JSON.stringify({
          pid: child.pid,
          owner: "schedule-cli other",
          acquiredAt: "2026-10-01T00:00:00.000Z",
        })}\n`,
        "utf8",
      );

      const result = await acquireSchedulerLock(directory, "schedule-cli mine");
      expect("heldBy" in result).toBe(true);
      if (!("heldBy" in result)) return;
      expect(result.heldBy.owner).toBe("schedule-cli other");

      const held = await readSchedulerLock(directory);
      expect(held?.owner).toBe("schedule-cli other");
    } finally {
      child.kill();
    }
  });

  it("takes over a lock left behind by a dead process", async () => {
    const { acquireSchedulerLock, readSchedulerLock, schedulerLockPath } =
      await import("../src/storage/scheduler-lock.js");
    const directory = await tempDirectory();
    // A pid that cannot exist, so the previous run must have died.
    await writeFile(
      schedulerLockPath(directory),
      `${JSON.stringify({
        pid: 2_147_483_646,
        owner: "schedule-cli crashed",
        acquiredAt: "2026-10-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );

    const result = await acquireSchedulerLock(directory, "schedule-cli fresh");
    expect("heldBy" in result).toBe(false);

    const held = await readSchedulerLock(directory);
    expect(held?.owner).toBe("schedule-cli fresh");
  });

  it("treats a corrupt lock file as absent", async () => {
    const { acquireSchedulerLock, schedulerLockPath } = await import(
      "../src/storage/scheduler-lock.js"
    );
    const directory = await tempDirectory();
    await writeFile(schedulerLockPath(directory), "{ not json", "utf8");

    const result = await acquireSchedulerLock(directory, "schedule-cli fresh");
    expect("heldBy" in result).toBe(false);
    const raw = await readFile(schedulerLockPath(directory), "utf8");
    expect(JSON.parse(raw).owner).toBe("schedule-cli fresh");
  });
});
