import { describe, expect, it } from "vitest";
import {
  assertTargetTransition,
  canTransitionTarget,
  InvalidTargetTransitionError,
  TargetState,
} from "../src/domain/target-state.js";

describe("target state transitions", () => {
  it("validates the successful lifecycle", () => {
    const lifecycle = [
      TargetState.DRAFT,
      TargetState.ARMED,
      TargetState.WAITING,
      TargetState.MATCH_FOUND,
      TargetState.VALIDATING,
      TargetState.BOOKING,
      TargetState.BOOKED,
    ] as const;

    for (let index = 0; index < lifecycle.length - 1; index += 1) {
      expect(canTransitionTarget(lifecycle[index]!, lifecycle[index + 1]!)).toBe(true);
    }
  });

  it("permits retryable booking stages to return to WAITING", () => {
    expect(canTransitionTarget(TargetState.MATCH_FOUND, TargetState.WAITING)).toBe(true);
    expect(canTransitionTarget(TargetState.VALIDATING, TargetState.WAITING)).toBe(true);
    expect(canTransitionTarget(TargetState.BOOKING, TargetState.WAITING)).toBe(true);
  });

  it("permits fail-closed pauses and requires re-arming after pause", () => {
    expect(canTransitionTarget(TargetState.WAITING, TargetState.PAUSED)).toBe(true);
    expect(canTransitionTarget(TargetState.PAUSED, TargetState.WAITING)).toBe(false);
    expect(canTransitionTarget(TargetState.PAUSED, TargetState.ARMED)).toBe(true);
  });

  it("rejects invalid transitions", () => {
    expect(() => assertTargetTransition(TargetState.DRAFT, TargetState.BOOKING)).toThrow(
      InvalidTargetTransitionError,
    );
  });

  it("makes BOOKED terminal for the current target", () => {
    for (const state of Object.values(TargetState)) {
      expect(canTransitionTarget(TargetState.BOOKED, state)).toBe(false);
    }
  });
});
