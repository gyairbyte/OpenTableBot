import { describe, expect, it, vi } from "vitest";
import { SchedulerTickLoop } from "../src/ui/tick-loop.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe("SchedulerTickLoop", () => {
  it("runs one scheduler pass per tick and records the time", async () => {
    const runDueTargets = vi.fn().mockResolvedValue(undefined);
    const loop = new SchedulerTickLoop(
      { runDueTargets },
      { now: () => new Date("2026-10-23T21:00:00.000Z") },
    );
    await loop.tickOnce();
    expect(runDueTargets).toHaveBeenCalledTimes(1);
    expect(loop.status().lastTickAt).toBe("2026-10-23T21:00:00.000Z");
    expect(loop.status().lastTickError).toBeUndefined();
  });

  it("never overlaps a slow pass", async () => {
    const gate = deferred();
    const runDueTargets = vi.fn().mockReturnValue(gate.promise);
    const loop = new SchedulerTickLoop({ runDueTargets });
    const first = loop.tickOnce();
    const second = loop.tickOnce();
    gate.resolve();
    await Promise.all([first, second]);
    expect(runDueTargets).toHaveBeenCalledTimes(1);
  });

  it("captures a scheduler failure without rejecting", async () => {
    const onError = vi.fn();
    const runDueTargets = vi.fn().mockRejectedValue(new Error("bridge offline"));
    const loop = new SchedulerTickLoop({ runDueTargets }, { onError });
    await expect(loop.tickOnce()).resolves.toBeUndefined();
    expect(loop.status().lastTickError).toBe("bridge offline");
    expect(onError).toHaveBeenCalledWith("bridge offline");
  });

  it("ticks on the configured interval until stopped", async () => {
    vi.useFakeTimers();
    try {
      const runDueTargets = vi.fn().mockResolvedValue(undefined);
      const loop = new SchedulerTickLoop({ runDueTargets }, { intervalMs: 1_000 });
      loop.start();
      await vi.advanceTimersByTimeAsync(3_000);
      await loop.stop();
      expect(runDueTargets).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(runDueTargets).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  // The console stands down while an unattended scheduled run owns the drop, so
  // two schedulers never drive the same target.
  it("skips the pass and reports why when another scheduler owns the run", async () => {
    const runDueTargets = vi.fn().mockResolvedValue(undefined);
    const loop = new SchedulerTickLoop(
      { runDueTargets },
      { blockedBy: async () => "An unattended scheduler owns this drop: schedule-cli (pid 42)" },
    );

    await loop.tickOnce();

    expect(runDueTargets).not.toHaveBeenCalled();
    expect(loop.status().schedulerSkippedReason).toContain("unattended scheduler owns this drop");
    expect(loop.status().lastTickAt).toBeUndefined();
  });

  it("resumes once the other scheduler releases the run", async () => {
    const runDueTargets = vi.fn().mockResolvedValue(undefined);
    let blocker: string | undefined = "held";
    const loop = new SchedulerTickLoop({ runDueTargets }, {
      blockedBy: async () => blocker,
    });

    await loop.tickOnce();
    expect(runDueTargets).not.toHaveBeenCalled();

    blocker = undefined;
    await loop.tickOnce();
    expect(runDueTargets).toHaveBeenCalledTimes(1);
    expect(loop.status().schedulerSkippedReason).toBeUndefined();
  });
});
