import { describe, expect, it } from "vitest";
import {
  BrowserPreparedState,
  LockTelemetryStage,
  canSubmitPreparedState,
  classifyInterruptedLock,
  advanceLockStage,
  claimLockStage,
  confirmedLockDisposition,
  remainingOperationMs,
} from "../src/opentable/bridge/lock-lifecycle.js";
import { LockProgressSchema } from "../src/opentable/bridge/protocol.js";

describe("lock dispatch boundary and lifecycle", () => {
  it.each([
    [undefined, "LOCK_NOT_DISPATCHED"],
    [LockTelemetryStage.LOCK_REQUEST_ACCEPTED, "LOCK_NOT_DISPATCHED"],
    [LockTelemetryStage.PAGE_OPERATION_RECEIVED, "LOCK_NOT_DISPATCHED"],
    [LockTelemetryStage.PROVIDER_DISPATCHED, "LOCK_OUTCOME_UNKNOWN"],
    [LockTelemetryStage.PROVIDER_RESPONSE_RECEIVED, "LOCK_OUTCOME_UNKNOWN"],
    [LockTelemetryStage.PREPARED_STATE_CREATED, "LOCK_OUTCOME_UNKNOWN"],
  ] as const)("classifies interruption at %s as %s", (stage, outcome) => {
    expect(classifyInterruptedLock(stage)).toBe(outcome);
  });

  it("propagates one deadline with a narrow response margin", () => {
    expect(remainingOperationMs(10_000, 4_000, 250)).toBe(5_750);
    expect(remainingOperationMs(4_000, 4_000, 250)).toBe(0);
    expect(remainingOperationMs(3_000, 4_000, 250)).toBe(0);
  });

  it("never regresses the furthest observed dispatch stage", () => {
    expect(advanceLockStage(undefined, LockTelemetryStage.PROVIDER_DISPATCHED)).toBe(
      LockTelemetryStage.PROVIDER_DISPATCHED,
    );
    expect(
      advanceLockStage(
        LockTelemetryStage.PROVIDER_DISPATCHED,
        LockTelemetryStage.PAGE_OPERATION_RECEIVED,
      ),
    ).toBe(LockTelemetryStage.PROVIDER_DISPATCHED);
  });

  it("claims each semantic telemetry stage only once", () => {
    const emitted = new Set<LockTelemetryStage>();
    expect(claimLockStage(emitted, LockTelemetryStage.LOCK_REQUEST_ACCEPTED)).toBe(true);
    expect(claimLockStage(emitted, LockTelemetryStage.LOCK_REQUEST_ACCEPTED)).toBe(false);
    expect(claimLockStage(emitted, LockTelemetryStage.PROVIDER_RESPONSE_RECEIVED)).toBe(true);
    expect(claimLockStage(emitted, LockTelemetryStage.PROVIDER_RESPONSE_RECEIVED)).toBe(false);
  });

  it("makes only revalidated prepared state submit-capable", () => {
    for (const state of Object.values(BrowserPreparedState)) {
      expect(canSubmitPreparedState(state)).toBe(state === BrowserPreparedState.REVALIDATED);
    }
  });

  it("keeps orphaned late success non-submit-capable", () => {
    expect(confirmedLockDisposition(true)).toEqual({
      state: BrowserPreparedState.ORPHANED,
      outcome: "LOCK_OUTCOME_UNKNOWN",
    });
    expect(canSubmitPreparedState(BrowserPreparedState.ORPHANED)).toBe(false);
    expect(canSubmitPreparedState(BrowserPreparedState.PENDING_ACK)).toBe(false);
  });

  it("keeps a normal confirmed lock pending until Node acknowledges it", () => {
    expect(confirmedLockDisposition(false)).toEqual({
      state: BrowserPreparedState.PENDING_ACK,
      outcome: "LOCK_CONFIRMED",
    });
    expect(canSubmitPreparedState(BrowserPreparedState.PENDING_ACK)).toBe(false);
  });

  it("preserves the operation correlation ID in sanitized telemetry", () => {
    const event = LockProgressSchema.parse({
      protocolVersion: 1,
      id: "lock-operation-123",
      type: "LOCK_PROGRESS",
      stage: "PROVIDER_DISPATCHED",
      elapsedMs: 42,
    });
    expect(event.id).toBe("lock-operation-123");
  });

  it.each(["slotHash", "cookie", "authorization", "providerPayload", "paymentToken"])(
    "rejects sensitive telemetry field %s",
    (field) => {
      expect(LockProgressSchema.safeParse({
        protocolVersion: 1,
        id: "lock-operation-123",
        type: "LOCK_PROGRESS",
        stage: "PROVIDER_DISPATCHED",
        elapsedMs: 42,
        [field]: "secret",
      }).success).toBe(false);
    },
  );
});
