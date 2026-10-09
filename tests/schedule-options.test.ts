import { describe, expect, it } from "vitest";
import {
  DEFAULT_WARM_UP_SECONDS,
  parseScheduleCliOptions,
} from "../src/opentable/bridge/schedule-options.js";

describe("parseScheduleCliOptions", () => {
  it("defaults every duration and converts seconds to milliseconds", () => {
    const options = parseScheduleCliOptions([]);
    expect(options.tickMs).toBe(5_000);
    expect(options.maxRuntimeMs).toBe(30 * 60_000);
    expect(options.warmUpLeadMs).toBe(DEFAULT_WARM_UP_SECONDS * 1_000);
    // The readiness budget must be a real duration, not a raw second count.
    expect(options.readinessMs).toBe(DEFAULT_WARM_UP_SECONDS * 1_000);
    expect(options.execute).toBe(true);
    expect(options.targetId).toBeUndefined();
  });

  it("honours an explicit readiness window in seconds", () => {
    const options = parseScheduleCliOptions(["--readiness-seconds", "45"]);
    expect(options.readinessMs).toBe(45_000);
  });

  it("defaults the readiness window to the warm-up window", () => {
    const options = parseScheduleCliOptions(["--warm-up-seconds", "90"]);
    expect(options.warmUpLeadMs).toBe(90_000);
    expect(options.readinessMs).toBe(90_000);
  });

  it("parses the target, execute flag, and durations", () => {
    const options = parseScheduleCliOptions([
      "--target-id",
      "don-angie",
      "--execute",
      "--tick-seconds",
      "2",
      "--max-runtime-minutes",
      "5",
      "--warm-up-seconds",
      "120",
      "--readiness-seconds",
      "120",
    ]);
    expect(options.targetId).toBe("don-angie");
    expect(options.execute).toBe(true);
    expect(options.tickMs).toBe(2_000);
    expect(options.maxRuntimeMs).toBe(5 * 60_000);
    expect(options.warmUpLeadMs).toBe(120_000);
    expect(options.readinessMs).toBe(120_000);
  });

  it("supports an explicit dry-run opt-out", () => {
    const options = parseScheduleCliOptions(["--dry-run"]);
    expect(options.execute).toBe(false);
  });

  it("rejects a non-positive duration", () => {
    expect(() => parseScheduleCliOptions(["--readiness-seconds", "0"])).toThrow(
      /--readiness-seconds must be a positive number/u,
    );
    expect(() => parseScheduleCliOptions(["--warm-up-seconds", "-5"])).toThrow(
      /--warm-up-seconds must be a positive number/u,
    );
  });

  it("rejects a malformed argument list", () => {
    expect(() => parseScheduleCliOptions(["--target-id"])).toThrow(/Expected --name value/u);
  });
});
