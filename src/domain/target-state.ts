export const TargetState = {
  DRAFT: "DRAFT",
  ARMED: "ARMED",
  WAITING: "WAITING",
  MATCH_FOUND: "MATCH_FOUND",
  VALIDATING: "VALIDATING",
  BOOKING: "BOOKING",
  BOOKED: "BOOKED",
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
  VALIDATING: [TargetState.BOOKING, TargetState.WAITING, TargetState.PAUSED],
  BOOKING: [TargetState.BOOKED, TargetState.WAITING, TargetState.PAUSED],
  BOOKED: [],
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
