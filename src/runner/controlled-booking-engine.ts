import type {
  AvailabilityAttempt,
  AvailabilityRunDetail,
  ObservedAvailabilitySlot,
} from "../domain/availability-detail.js";
import type { ReservationSlot } from "../domain/reservation-slot.js";
import { supportsLazyDiscovery } from "../opentable/adapter.js";
import type { BookingTarget } from "../domain/booking-target.js";
import {
  RUNNABLE_TARGET_STATES,
  TargetState,
  assertTargetTransition,
  canTransitionTarget,
} from "../domain/target-state.js";
import {
  AdapterFailureCategory,
  AdapterFailureDisposition,
  OpenTableAdapterError,
} from "../opentable/errors.js";
import type { TargetRecord } from "../storage/target-store.js";
import type {
  BookingEngine,
  BookingEngineDependencies,
} from "./booking-engine.js";
import {
  eagerCandidateStream,
  lazyCandidateStream,
  type CandidateStream,
} from "./candidate-stream.js";
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
   * Cancellation watchers ignore this and read once per poll.
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

/**
 * How many ranked candidates one run will try before giving up. Each attempt
 * costs several provider round trips, and a drop that has gone this far is
 * better handed back to a person than hammered.
 */
const MAX_CANDIDATE_ATTEMPTS = 5;

/**
 * Whether a failed attempt may move on to the next-ranked candidate. Only when
 * no reservation and no lock can exist for the failed slot: before the lock
 * stage a table that has vanished, or at the lock stage an explicit provider
 * refusal. Anything ambiguous, and anything at or after a confirmed lock or a
 * submit, must stop the run so a table is never held or booked twice.
 */
function canTryNextCandidate(
  error: unknown,
  stage: ControlledBookingStage | undefined,
): boolean {
  if (!(error instanceof OpenTableAdapterError)) return false;
  if (stage === undefined) return error.category === AdapterFailureCategory.SLOT_DISAPPEARED;
  return stage === "locking" && error.category === AdapterFailureCategory.LOCK_REJECTED;
}

function describeFailure(error: unknown): string {
  if (error instanceof OpenTableAdapterError) {
    return `${error.category}: ${error.message}`;
  }
  return error instanceof Error ? error.message : "Unknown booking failure";
}

/** Whether a run may book any acceptable time in the window, not just the preferred one. */
function acceptsWindow(target: BookingTarget): boolean {
  return (
    target.mode === "cancellation-watch" || target.acceptAnyTimeInWindow === true
  );
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
  const wanted = acceptsWindow(target)
    ? `No acceptable time in the ${target.timeWindow.earliest}-${target.timeWindow.latest} window`
    : `No slot at the preferred time ${target.timeWindow.preferred}`;
  const base = `${wanted} after ${attemptCount} availability attempt(s); ${attempts[attempts.length - 1]?.acceptableSlots ?? 0} slot(s) were returned`;
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
 * Scheduler engine for one run of one target.
 *
 * A known-drop run is single-shot and selects only a slot at the target's
 * exact preferred time; when that time is absent it pauses and notifies
 * instead of substituting a nearby time, unless the target sets
 * acceptAnyTimeInWindow, in which case it books the acceptable time closest
 * to the preferred one. A cancellation-watch run always accepts any
 * acceptable time inside the configured window, takes the one closest to the
 * preferred time, and returns to ARMED so the scheduler can poll again.
 *
 * Every failure is fail-closed: it pauses unless a cancellation watcher can
 * safely resume watching. An ambiguous submission becomes terminal
 * OUTCOME_UNKNOWN and is never retried, in either mode.
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

    // Set once availability has been read, so a pause after that point carries
    // the evidence as it stood when the run ended, including any times that
    // were looked up after the first booking attempt.
    const detailSource: { build?: () => AvailabilityRunDetail } = {};

    const pause = async (
      reason: string,
      availabilityDetail?: AvailabilityRunDetail,
    ): Promise<void> => {
      if (!canTransitionTarget(current.state, TargetState.PAUSED)) return;
      const detail = availabilityDetail ?? detailSource.build?.();
      current = await store.save(
        {
          ...current,
          state: TargetState.PAUSED,
          pauseReason: reason,
          ...(detail === undefined ? {} : { availabilityDetail: detail }),
        },
        current.version,
      );
      await notifier.notify({ type: "target-paused", targetId, reason });
    };

    /**
     * Returns a cancellation watcher to ARMED so the next poll happens. A
     * mid-flight state is routed through SLOT_LOST, the transition the state
     * machine already defines for a lock attempt that did not complete.
     * Reports whether the watch actually resumed, so a caller can fail closed
     * instead of leaving the target parked in a state no scheduler polls.
     */
    const resumeWatching = async (
      patch: Partial<TargetRecord> = {},
    ): Promise<boolean> => {
      const resumePatch = { pauseReason: undefined, ...patch };
      const waiting = (): boolean =>
        current.state === TargetState.ARMED ||
        current.state === TargetState.WAITING;
      if (
        !waiting() &&
        !canTransitionTarget(current.state, TargetState.WAITING) &&
        canTransitionTarget(current.state, TargetState.SLOT_LOST)
      ) {
        await move(TargetState.SLOT_LOST, resumePatch);
      }
      if (!waiting() && canTransitionTarget(current.state, TargetState.WAITING)) {
        await move(TargetState.WAITING, resumePatch);
      }
      if (current.state === TargetState.WAITING) {
        await move(TargetState.ARMED, resumePatch);
      }
      return current.state === TargetState.ARMED;
    };

    /**
     * A retryable failure only ends a cancellation watch when resuming it
     * would be unsafe or impossible. SUBMITTING is excluded deliberately: a
     * transport failure there leaves the submission outcome ambiguous, so the
     * watcher must stop and be inspected rather than quietly book again.
     */
    const handleFailure = async (error: unknown, note = ""): Promise<void> => {
      if (
        target.mode === "cancellation-watch" &&
        error instanceof OpenTableAdapterError &&
        error.disposition === AdapterFailureDisposition.RETRY_WAITING &&
        current.state !== TargetState.SUBMITTING &&
        (await resumeWatching(
          // A slot that vanished or a lock that never dispatched happens after
          // a successful scan, so only the other retryable failures mean the
          // watcher could not see availability at all.
          error.category === AdapterFailureCategory.SLOT_DISAPPEARED ||
            error.category === AdapterFailureCategory.LOCK_NOT_DISPATCHED
            ? {}
            : { scanBlockedReason: describeFailure(error) },
        ))
      ) {
        return;
      }
      await pause(`${describeFailure(error)}${note}`);
    };

    // Moving into WAITING also clears any availability detail left over from
    // a previous run, so the console can never mistake an old capture for
    // this run's evidence. A target that is already waiting skips the
    // redundant self-transition.
    if (current.state !== TargetState.WAITING) {
      await move(TargetState.WAITING, {
        availabilityDetail: undefined,
        scanBlockedReason: undefined,
      });
    }

    // A watcher's next poll is the retry; re-reading within one run only
    // multiplies requests against OpenTable.
    const availabilityAttempts =
      target.mode === "cancellation-watch"
        ? 1
        : (this.options.availabilityAttempts ?? 1);
    const availabilityRetryDelayMs = this.options.availabilityRetryDelayMs ?? 250;
    const now = this.options.now ?? (() => Date.now());
    const attemptFacts: Array<{
      readonly startedAt: string;
      readonly durationMs: number;
      readonly acceptable: number;
      readonly preferred: number;
      readonly observedSlots: readonly ObservedAvailabilitySlot[];
    }> = [];
    let stream: CandidateStream = {
      next: async () => undefined,
      stats: () => ({ acceptable: 0, preferred: 0 }),
      finish: () => undefined,
    };
    let observedSlots: readonly ObservedAvailabilitySlot[] = [];
    let first: ReservationSlot | undefined;
    const snapshotObserved = (
      slots: readonly ObservedAvailabilitySlot[],
    ): readonly ObservedAvailabilitySlot[] =>
      slots.map((slot) => ({ ...slot, diningAreas: [...slot.diningAreas] }));
    for (let attempt = 1; attempt <= availabilityAttempts; attempt += 1) {
      const startedAtMs = now();
      try {
        // A watcher accepts any acceptable time inside the window and lets the
        // ranking pick the one closest to the preferred time. A known-drop run
        // does the same only when the target opts in with acceptAnyTimeInWindow;
        // otherwise it considers the exact preferred time only.
        const streamOptions = { preferredOnly: !acceptsWindow(target) };
        if (supportsLazyDiscovery(adapter)) {
          // Look up open times first and establish dining areas one time at a
          // time, best first, so booking starts without waiting for the rest.
          const base = await adapter.findBaseSlots(target);
          observedSlots = base.observedSlots;
          stream = lazyCandidateStream(adapter, target, base, streamOptions);
        } else {
          const observed = await adapter.findSlotsDetailed(target);
          observedSlots = observed.observedSlots;
          stream = eagerCandidateStream(target, observed.acceptableSlots, streamOptions);
        }
        first = await stream.next();
      } catch (error) {
        await handleFailure(error);
        return;
      }
      const stats = stream.stats();
      attemptFacts.push({
        startedAt: new Date(startedAtMs).toISOString(),
        durationMs: Math.max(0, now() - startedAtMs),
        acceptable: stats.acceptable,
        preferred: stats.preferred,
        observedSlots: snapshotObserved(observedSlots),
      });
      if (first !== undefined || attempt === availabilityAttempts) break;
      await new Promise((resolve) => setTimeout(resolve, availabilityRetryDelayMs));
    }
    // Later times may still be looked up after the first booking attempt, so the
    // detail is rebuilt from the live stream whenever it is written.
    const buildDetail = (): AvailabilityRunDetail => {
      const last = attemptFacts.length - 1;
      return {
        preferredTime: target.timeWindow.preferred,
        earliest: target.timeWindow.earliest,
        latest: target.timeWindow.latest,
        matched: first !== undefined,
        capturedAt: new Date(now()).toISOString(),
        attempts: attemptFacts.map((fact, index): AvailabilityAttempt => {
          const live = index === last ? stream.stats() : undefined;
          return {
            startedAt: fact.startedAt,
            durationMs: fact.durationMs,
            acceptableSlots: live?.acceptable ?? fact.acceptable,
            preferredSlots: live?.preferred ?? fact.preferred,
            observedSlots:
              index === last ? snapshotObserved(observedSlots) : fact.observedSlots,
          };
        }),
      };
    };
    detailSource.build = buildDetail;
    if (first === undefined) {
      stream.finish();
      const availabilityDetail = buildDetail();
      // The watcher keeps its scan evidence while it stays armed, so the
      // console can show what the most recent poll actually saw.
      if (
        target.mode === "cancellation-watch" &&
        (await resumeWatching({ availabilityDetail }))
      ) {
        return;
      }
      await pause(
        target.mode === "cancellation-watch"
          ? `Watcher found no acceptable time in ${target.timeWindow.earliest}-${target.timeWindow.latest} after ${availabilityAttempts} availability attempt(s)`
          : describeNoMatch(target, availabilityDetail.attempts, availabilityAttempts),
        availabilityDetail,
      );
      return;
    }

    await move(TargetState.MATCH_FOUND, { availabilityDetail: buildDetail() });
    await move(TargetState.VALIDATING);

    // Try the best candidate; if it is gone, move to the next-ranked one. Only a
    // failure that provably left no lock or reservation behind may do so.
    const progress: { stage: ControlledBookingStage | undefined } = { stage: undefined };
    let slot: ReservationSlot | undefined = first;
    let tried = 0;
    while (slot !== undefined) {
      tried += 1;
      progress.stage = undefined;
      try {
        const result = await runControlledBooking(adapter, target, slot, {
          execute,
          onStage: async (stage) => {
            progress.stage = stage;
            await move(STAGE_STATES[stage]);
          },
        });
        stream.finish();
        if (result.status === "dry-run") {
          // A Dry Run watcher neither locks nor submits, so there is nothing to
          // inspect and pausing would end a watch the operator asked to keep.
          if (
            target.mode === "cancellation-watch" &&
            (await resumeWatching({ availabilityDetail: buildDetail() }))
          ) {
            return;
          }
          await pause("Dry run completed; no reservation was created");
          return;
        }
        if (result.submission.status === "confirmed") {
          await move(TargetState.BOOKED, {
            confirmation: result.submission.confirmation,
            availabilityDetail: buildDetail(),
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
          availabilityDetail: buildDetail(),
        });
        await notifier.notify({
          type: "target-paused",
          targetId,
          reason: result.submission.message,
        });
        return;
      } catch (error) {
        let next: ReservationSlot | undefined;
        if (tried < MAX_CANDIDATE_ATTEMPTS && canTryNextCandidate(error, progress.stage)) {
          try {
            next = await stream.next();
          } catch (discoveryError) {
            stream.finish();
            await handleFailure(discoveryError);
            return;
          }
        }
        if (next === undefined) {
          stream.finish();
          await handleFailure(
            error,
            tried > 1 ? ` (after trying ${tried} candidate times)` : "",
          );
          return;
        }
        try {
          // A rejected lock leaves the target in LOCKING; route it back to
          // VALIDATING through the transitions the state machine defines.
          if (progress.stage === "locking") {
            await move(TargetState.SLOT_LOST);
            await move(TargetState.WAITING);
            await move(TargetState.MATCH_FOUND);
            await move(TargetState.VALIDATING);
          }
        } catch (stateError) {
          await handleFailure(stateError);
          return;
        }
        slot = next;
      }
    }
  }
}
