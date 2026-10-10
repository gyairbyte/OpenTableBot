import type {
  AvailabilityAttempt,
  AvailabilityRunDetail,
} from "../domain/availability-detail.js";
import type { BookingTarget } from "../domain/booking-target.js";
import type { ReservationSlot } from "../domain/reservation-slot.js";
import {
  RUNNABLE_TARGET_STATES,
  TargetState,
  assertTargetTransition,
  canTransitionTarget,
} from "../domain/target-state.js";
import { OpenTableAdapterError } from "../opentable/errors.js";
import type { TargetRecord } from "../storage/target-store.js";
import {
  createBookingPlan,
  type BookingEngine,
  type BookingEngineDependencies,
} from "./booking-engine.js";
import {
  runControlledBooking,
  type ControlledBookingStage,
} from "./controlled-booking.js";

export interface ControlledBookingEngineOptions {
  /**
   * A function permits the operator console to switch mode without rebuilding
   * the scheduler and adapter stack. Boolean callers remain supported for CLI
   * and test use.
   */
  readonly execute: boolean | (() => boolean);
  /**
   * Availability is read repeatedly only when the exact preferred time is
   * absent. The default preserves the original single-shot behavior.
   */
  readonly availabilityAttempts?: number;
  readonly availabilityRetryDelayMs?: number;
  /** Injectable clock for deterministic run-detail timestamps. */
  readonly now?: () => number;
}

const STAGE_STATES: Readonly<Record<ControlledBookingStage, TargetState>> = {
  locking: TargetState.LOCKING,
  locked: TargetState.LOCKED,
  revalidating: TargetState.REVALIDATING,
  submitting: TargetState.SUBMITTING,
};

function describeFailure(error: unknown): string {
  if (error instanceof OpenTableAdapterError) {
    return `${error.category}: ${error.message}`;
  }
  return error instanceof Error ? error.message : "Unknown booking failure";
}

/**
 * Human-readable no-match summary. The stored availability detail carries the
 * full evidence; this reason makes the single most useful distinction visible
 * without clicking: nothing was open at all versus open times existed but
 * every one of them fell outside the configured window.
 */
function describeNoMatch(
  target: BookingTarget,
  attempts: readonly AvailabilityAttempt[],
  attemptCount: number,
): string {
  const base = `No slot at the preferred time ${target.timeWindow.preferred} after ${attemptCount} availability attempt(s); ${attempts[attempts.length - 1]?.acceptableSlots ?? 0} slot(s) were returned`;
  const lastObserved = attempts[attempts.length - 1]?.observedSlots ?? [];
  if (lastObserved.length === 0) {
    return `${base}, and no open times were observed at all`;
  }
  const outsideWindow = lastObserved.filter((slot) => !slot.withinWindow);
  const insideWindow = lastObserved.length - outsideWindow.length;
  const window = `${target.timeWindow.earliest}-${target.timeWindow.latest}`;
  if (outsideWindow.length > 0 && insideWindow === 0) {
    return `${base}, ${outsideWindow.length} open time(s) were all outside the ${window} window`;
  }
  return `${base}, ${lastObserved.length} open time(s) were observed (${outsideWindow.length} outside the ${window} window)`;
}

/**
 * Single-shot scheduler engine. It selects only a slot at the target's exact
 * preferred time; when that time is absent it pauses and notifies instead of
 * substituting a nearby time. Every failure is fail-closed into PAUSED, and an
 * ambiguous submission becomes terminal OUTCOME_UNKNOWN and is never retried.
 */
export class ControlledBookingEngine implements BookingEngine {
  constructor(
    private readonly dependencies: BookingEngineDependencies,
    private readonly options: ControlledBookingEngineOptions,
  ) {}

  async runOnce(targetId: string): Promise<void> {
    const { adapter, store, notifier } = this.dependencies;
    const record = await store.get(targetId);
    if (record === undefined) throw new Error(`Unknown target: ${targetId}`);
    if (!RUNNABLE_TARGET_STATES.includes(record.state)) return;

    const target = record.target;
    let current = record;
    const execute =
      typeof this.options.execute === "function"
        ? this.options.execute()
        : this.options.execute;

    const move = async (
      to: TargetState,
      patch: Partial<TargetRecord> = {},
    ): Promise<void> => {
      const from = current.state;
      assertTargetTransition(from, to);
      current = await store.save(
        { ...current, ...patch, state: to },
        current.version,
      );
      await notifier.notify({ type: "state-changed", targetId, from, to });
    };

    const pause = async (
      reason: string,
      availabilityDetail?: AvailabilityRunDetail,
    ): Promise<void> => {
      if (!canTransitionTarget(current.state, TargetState.PAUSED)) return;
      current = await store.save(
        {
          ...current,
          state: TargetState.PAUSED,
          pauseReason: reason,
          ...(availabilityDetail === undefined
            ? {}
            : { availabilityDetail }),
        },
        current.version,
      );
      await notifier.notify({ type: "target-paused", targetId, reason });
    };

    // Moving into WAITING also clears any availability detail left over from
    // a previous run, so the console can never mistake an old capture for
    // this run's evidence. A target that is already waiting skips the
    // redundant self-transition.
    if (current.state !== TargetState.WAITING) {
      await move(TargetState.WAITING, { availabilityDetail: undefined });
    }

    const availabilityAttempts = this.options.availabilityAttempts ?? 1;
    const availabilityRetryDelayMs = this.options.availabilityRetryDelayMs ?? 250;
    const now = this.options.now ?? (() => Date.now());
    let slots: readonly ReservationSlot[] = [];
    let preferred: readonly ReservationSlot[] = [];
    const attempts: AvailabilityAttempt[] = [];
    for (let attempt = 1; attempt <= availabilityAttempts; attempt += 1) {
      const startedAtMs = now();
      let observed;
      try {
        observed = await adapter.findSlotsDetailed(target);
        slots = observed.acceptableSlots;
      } catch (error) {
        await pause(describeFailure(error));
        return;
      }
      preferred = slots.filter(
        (slot) => slot.localTime === target.timeWindow.preferred,
      );
      attempts.push({
        startedAt: new Date(startedAtMs).toISOString(),
        durationMs: Math.max(0, now() - startedAtMs),
        acceptableSlots: slots.length,
        preferredSlots: preferred.length,
        observedSlots: observed.observedSlots,
      });
      if (preferred.length > 0 || attempt === availabilityAttempts) break;
      await new Promise((resolve) => setTimeout(resolve, availabilityRetryDelayMs));
    }
    const availabilityDetail: AvailabilityRunDetail = {
      preferredTime: target.timeWindow.preferred,
      earliest: target.timeWindow.earliest,
      latest: target.timeWindow.latest,
      matched: preferred.length > 0,
      capturedAt: new Date(now()).toISOString(),
      attempts,
    };
    const plan = createBookingPlan(target, preferred);
    if (plan.kind === "no-match") {
      await pause(describeNoMatch(target, attempts, availabilityAttempts), availabilityDetail);
      return;
    }

    await move(TargetState.MATCH_FOUND, { availabilityDetail });
    await move(TargetState.VALIDATING);

    try {
      const result = await runControlledBooking(adapter, target, plan.selected, {
        execute,
        onStage: async (stage) => {
          await move(STAGE_STATES[stage]);
        },
      });
      if (result.status === "dry-run") {
        await pause("Dry run completed; no reservation was created");
        return;
      }
      if (result.submission.status === "confirmed") {
        await move(TargetState.BOOKED, {
          confirmation: result.submission.confirmation,
        });
        await notifier.notify({
          type: "booking-confirmed",
          targetId,
          confirmation: result.submission.confirmation,
        });
        return;
      }
      await move(TargetState.OUTCOME_UNKNOWN, {
        pauseReason: result.submission.message,
      });
      await notifier.notify({
        type: "target-paused",
        targetId,
        reason: result.submission.message,
      });
    } catch (error) {
      await pause(describeFailure(error));
    }
  }
}
