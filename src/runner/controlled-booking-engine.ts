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
  readonly execute: boolean;
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

    const pause = async (reason: string): Promise<void> => {
      if (!canTransitionTarget(current.state, TargetState.PAUSED)) return;
      current = await store.save(
        { ...current, state: TargetState.PAUSED, pauseReason: reason },
        current.version,
      );
      await notifier.notify({ type: "target-paused", targetId, reason });
    };

    await move(TargetState.WAITING);

    let slots: readonly ReservationSlot[];
    try {
      slots = await adapter.findSlots(target);
    } catch (error) {
      await pause(describeFailure(error));
      return;
    }

    const preferred = slots.filter(
      (slot) => slot.localTime === target.timeWindow.preferred,
    );
    const plan = createBookingPlan(target, preferred);
    if (plan.kind === "no-match") {
      await pause(
        `No slot at the preferred time ${target.timeWindow.preferred}; ${slots.length} slot(s) were returned`,
      );
      return;
    }

    await move(TargetState.MATCH_FOUND);
    await move(TargetState.VALIDATING);

    try {
      const result = await runControlledBooking(adapter, target, plan.selected, {
        execute: this.options.execute,
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
