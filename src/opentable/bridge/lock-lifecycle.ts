export const LockTelemetryStage = {
  LOCK_REQUEST_ACCEPTED: "LOCK_REQUEST_ACCEPTED",
  PAGE_OPERATION_RECEIVED: "PAGE_OPERATION_RECEIVED",
  PROVIDER_DISPATCHED: "PROVIDER_DISPATCHED",
  PROVIDER_RESPONSE_RECEIVED: "PROVIDER_RESPONSE_RECEIVED",
  LOCK_PARSED: "LOCK_PARSED",
  PREPARED_STATE_CREATED: "PREPARED_STATE_CREATED",
  RESPONSE_SENT_TO_NODE: "RESPONSE_SENT_TO_NODE",
  RESPONSE_RECEIVED_BY_NODE: "RESPONSE_RECEIVED_BY_NODE",
} as const;

export type LockTelemetryStage =
  (typeof LockTelemetryStage)[keyof typeof LockTelemetryStage];

const stageOrder: Readonly<Record<LockTelemetryStage, number>> = {
  LOCK_REQUEST_ACCEPTED: 0,
  PAGE_OPERATION_RECEIVED: 1,
  PROVIDER_DISPATCHED: 2,
  PROVIDER_RESPONSE_RECEIVED: 3,
  LOCK_PARSED: 4,
  PREPARED_STATE_CREATED: 5,
  RESPONSE_SENT_TO_NODE: 6,
  RESPONSE_RECEIVED_BY_NODE: 7,
};

/** Preserve the furthest observed stage even if duplicate transports deliver older progress late. */
export function advanceLockStage(
  current: LockTelemetryStage | undefined,
  candidate: LockTelemetryStage,
): LockTelemetryStage {
  if (current === undefined || stageOrder[candidate] > stageOrder[current]) return candidate;
  return current;
}

export type InterruptedLockOutcome = "LOCK_NOT_DISPATCHED" | "LOCK_OUTCOME_UNKNOWN";

/** Only the provider-facing dispatch stage makes interruption ambiguous. */
export function classifyInterruptedLock(
  latestStage: LockTelemetryStage | undefined,
): InterruptedLockOutcome {
  return latestStage !== undefined &&
    stageOrder[latestStage] >= stageOrder.PROVIDER_DISPATCHED
    ? "LOCK_OUTCOME_UNKNOWN"
    : "LOCK_NOT_DISPATCHED";
}

export function remainingOperationMs(
  deadlineEpochMs: number,
  nowEpochMs = Date.now(),
  responseMarginMs = 250,
): number {
  return Math.max(0, deadlineEpochMs - nowEpochMs - responseMarginMs);
}

export const BrowserPreparedState = {
  PENDING_ACK: "PENDING_ACK",
  ACKNOWLEDGED: "ACKNOWLEDGED",
  REVALIDATED: "REVALIDATED",
  ORPHANED: "ORPHANED",
  SUBMITTING: "SUBMITTING",
  CONFIRMED: "CONFIRMED",
  FAILED_DEFINITIVE: "FAILED_DEFINITIVE",
  OUTCOME_UNKNOWN: "OUTCOME_UNKNOWN",
} as const;

export type BrowserPreparedState =
  (typeof BrowserPreparedState)[keyof typeof BrowserPreparedState];

export function canSubmitPreparedState(state: BrowserPreparedState): boolean {
  return state === BrowserPreparedState.REVALIDATED;
}

export function confirmedLockDisposition(callerAbandoned: boolean): {
  readonly state: BrowserPreparedState;
  readonly outcome: "LOCK_CONFIRMED" | "LOCK_OUTCOME_UNKNOWN";
} {
  return callerAbandoned
    ? { state: BrowserPreparedState.ORPHANED, outcome: "LOCK_OUTCOME_UNKNOWN" }
    : { state: BrowserPreparedState.PENDING_ACK, outcome: "LOCK_CONFIRMED" };
}
