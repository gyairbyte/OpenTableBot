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
});
