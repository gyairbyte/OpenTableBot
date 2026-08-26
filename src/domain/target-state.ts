export const TargetState = {
  DRAFT: "DRAFT",
  ARMED: "ARMED",
  WAITING: "WAITING",
  MATCH_FOUND: "MATCH_FOUND",
  VALIDATING: "VALIDATING",
  LOCKING: "LOCKING",
  LOCKED: "LOCKED",
  REVALIDATING: "REVALIDATING",
  /** Legacy coarse Phase 0 state retained for stored-state compatibility. */
  BOOKING: "BOOKING",
  SUBMITTING: "SUBMITTING",
  BOOKED: "BOOKED",
  SLOT_LOST: "SLOT_LOST",
  OUTCOME_UNKNOWN: "OUTCOME_UNKNOWN",
  PAUSED: "PAUSED",
} as const;

export type TargetState = (typeof TargetState)[keyof typeof TargetState];

export const allowedTargetTransitions: Readonly<
  Record<TargetState, readonly TargetState[]>
> = {
  DRAFT: [TargetState.ARMED],
  ARMED: [TargetState.WAITING, TargetState.PAUSED],
  WAITING: [TargetState.MATCH_FOUND, TargetState.PAUSED],
  MATCH_FOUND: [TargetState.VALIDATING, TargetState.WAITING, TargetState.PAUSED],
  VALIDATING: [TargetState.LOCKING, TargetState.BOOKING, TargetState.WAITING, TargetState.PAUSED],
  LOCKING: [TargetState.LOCKED, TargetState.SLOT_LOST, TargetState.PAUSED],
  LOCKED: [TargetState.REVALIDATING, TargetState.PAUSED],
  REVALIDATING: [TargetState.SUBMITTING, TargetState.SLOT_LOST, TargetState.PAUSED],
  BOOKING: [TargetState.BOOKED, TargetState.WAITING, TargetState.PAUSED],
  SUBMITTING: [TargetState.BOOKED, TargetState.OUTCOME_UNKNOWN, TargetState.PAUSED],
  BOOKED: [],
  SLOT_LOST: [TargetState.WAITING, TargetState.PAUSED],
  OUTCOME_UNKNOWN: [TargetState.PAUSED],
  PAUSED: [TargetState.ARMED],
};

export function canTransitionTarget(
  from: TargetState,
  to: TargetState,
): boolean {
  return allowedTargetTransitions[from].includes(to);
}

export class InvalidTargetTransitionError extends Error {
  constructor(
    readonly from: TargetState,
    readonly to: TargetState,
  ) {
    super(`Invalid target transition: ${from} -> ${to}`);
    this.name = "InvalidTargetTransitionError";
  }
}

export function assertTargetTransition(
  from: TargetState,
  to: TargetState,
): void {
  if (!canTransitionTarget(from, to)) {
    throw new InvalidTargetTransitionError(from, to);
  }
}
