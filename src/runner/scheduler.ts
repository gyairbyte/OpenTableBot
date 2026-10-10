import type { OpenTableReadAdapter } from "../opentable/adapter.js";
import { TargetState, canTransitionTarget } from "../domain/target-state.js";
import type { Notifier } from "../notifications/notifier.js";
import type { TargetRecord, TargetStore } from "../storage/target-store.js";
import type { BookingEngine } from "./booking-engine.js";

export interface SchedulerReadiness {
  readonly ready: boolean;
  /** Short, operator-facing explanation, e.g. "extension not connected". */
  readonly detail: string;
}

export interface ReservationSchedulerOptions {
  /** How long before the drop to begin verifying readiness. Default 60 s. */
  readonly warmUpLeadMs?: number;
  /** Readiness poll interval during warm-up. Default 5 s. */
  readonly readinessPollMs?: number;
  /** Minimum interval between cancellation-watch availability checks. */
  readonly cancellationWatchPollMs?: number;
  /**
   * Full readiness probe: the browser session must be usable, not merely
   * signed in. When supplied, the scheduler refuses to start a run against a
   * browser that never became ready instead of failing inside the engine.
   */
  readonly readiness?: () => Promise<SchedulerReadiness>;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

const DEFAULT_WARM_UP_LEAD_MS = 60_000;
const DEFAULT_READINESS_POLL_MS = 5_000;
const DEFAULT_CANCELLATION_WATCH_POLL_MS = 30_000;

function localDateInTimeZone(now: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now));
  const values = new Map(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

/**
 * Scheduler for both target modes.
 *
 * For each due `known-drop` target it warms up before the release time, waits
 * until the drop, then delegates exactly one attempt to the engine. It never
 * retries after the drop.
 *
 * For each `cancellation-watch` target it throttles to one engine run per poll
 * interval and keeps doing so until the watcher books, reaches its configured
 * stop time, or outlives the reservation date.
 *
 * In both modes transient and safety failures are handled by the engine's
 * fail-closed pause.
 */
export class ReservationScheduler {
  private readonly warmUpLeadMs: number;
  private readonly readinessPollMs: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly readiness: (() => Promise<SchedulerReadiness>) | undefined;
  private readonly cancellationWatchPollMs: number;
  private readonly lastCancellationWatchAt = new Map<string, number>();

  constructor(
    private readonly engine: BookingEngine,
    private readonly adapter: Pick<OpenTableReadAdapter, "checkAuthentication">,
    private readonly store: TargetStore,
    private readonly notifier: Notifier,
    options: ReservationSchedulerOptions = {},
  ) {
    this.warmUpLeadMs = options.warmUpLeadMs ?? DEFAULT_WARM_UP_LEAD_MS;
    this.readinessPollMs = options.readinessPollMs ?? DEFAULT_READINESS_POLL_MS;
    this.now = options.now ?? (() => Date.now());
    this.readiness = options.readiness;
    this.cancellationWatchPollMs =
      options.cancellationWatchPollMs ?? DEFAULT_CANCELLATION_WATCH_POLL_MS;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => {
          setTimeout(resolve, milliseconds);
        }));
  }

  async runDueTargets(): Promise<void> {
    for (const record of await this.store.listRunnable()) {
      await this.runTarget(record);
    }
  }

  async runTargetNow(record: TargetRecord): Promise<void> {
    const current = await this.store.get(record.target.id);
    if (current === undefined) return;
    if (this.readiness !== undefined) {
      const readiness = await this.probeReadiness();
      if (!readiness.ready) {
        await this.pause(
          current,
          `Browser was not ready for an immediate run (${readiness.detail})`,
        );
        return;
      }
    }
    await this.engine.runOnce(current.target.id);
  }

  async runTarget(record: TargetRecord): Promise<void> {
    const target = record.target;
    if (target.mode === "cancellation-watch") {
      await this.runCancellationWatch(record);
      return;
    }
    if (
      target.mode !== "known-drop" ||
      target.knownReservationReleaseAt === undefined
    ) {
      return;
    }
    const releaseAt = Date.parse(target.knownReservationReleaseAt);
    if (Number.isNaN(releaseAt)) {
      await this.pause(record, "knownReservationReleaseAt is not a valid timestamp");
      return;
    }
    if (this.now() < releaseAt - this.warmUpLeadMs) return;
    if (this.now() < releaseAt) {
      await this.waitForReadiness(releaseAt);
      const remaining = releaseAt - this.now();
      if (remaining > 0) await this.sleep(remaining);
    }
    // A scheduled run may start on a machine that just resumed. If the browser
    // never came up, pausing with the reason is far more useful than letting the
    // engine fail against a page that is not there.
    if (this.readiness !== undefined) {
      const readiness = await this.probeReadiness();
      if (!readiness.ready) {
        await this.pause(
          record,
          `Browser was not ready at the release time (${readiness.detail})`,
        );
        return;
      }
    }
    await this.engine.runOnce(target.id);
  }

  private async runCancellationWatch(record: TargetRecord): Promise<void> {
    const target = record.target;
    const now = this.now();
    const stopAt = target.cancellationWatchStopAt === undefined
      ? undefined
      : Date.parse(target.cancellationWatchStopAt);
    if (stopAt !== undefined && (Number.isNaN(stopAt) || now >= stopAt)) {
      await this.pause(record, "Cancellation watcher reached its configured stop time");
      return;
    }
    if (localDateInTimeZone(now, target.restaurant.timeZone) > target.dateRange.endDate) {
      await this.pause(record, "Cancellation watcher passed the target date");
      return;
    }
    const lastRun = this.lastCancellationWatchAt.get(target.id);
    if (lastRun !== undefined && now - lastRun < this.cancellationWatchPollMs) return;
    // A watcher runs for hours, so a browser that is momentarily unavailable
    // (a closed tab, a reloading extension, a machine resuming from sleep) has
    // to be survivable. Skipping this poll leaves the target armed for the
    // next one; pausing here would silently end the watch instead.
    if (!(await this.probeReadiness()).ready) return;
    this.lastCancellationWatchAt.set(target.id, now);
    await this.engine.runOnce(target.id);
  }

  private async probeReadiness(): Promise<SchedulerReadiness> {
    if (this.readiness !== undefined) {
      try {
        return await this.readiness();
      } catch (error) {
        return {
          ready: false,
          detail: error instanceof Error ? error.message : "readiness probe failed",
        };
      }
    }
    // Without a full probe, fall back to the conservative sign-in check.
    const status = await this.adapter.checkAuthentication();
    return status.authenticated
      ? { ready: true, detail: "authenticated" }
      : { ready: false, detail: `OpenTable session ${status.reason}` };
  }

  private async waitForReadiness(releaseAt: number): Promise<void> {
    while (this.now() < releaseAt) {
      try {
        if ((await this.probeReadiness()).ready) return;
      } catch {
        // Not ready yet; keep polling within the warm-up window.
      }
      const remaining = releaseAt - this.now();
      if (remaining <= 0) return;
      await this.sleep(Math.min(this.readinessPollMs, remaining));
    }
  }

  private async pause(record: TargetRecord, reason: string): Promise<void> {
    const current = await this.store.get(record.target.id);
    if (current === undefined) return;
    if (!canTransitionTarget(current.state, TargetState.PAUSED)) return;
    await this.store.save(
      { ...current, state: TargetState.PAUSED, pauseReason: reason },
      current.version,
    );
    await this.notifier.notify({
      type: "target-paused",
      targetId: record.target.id,
      reason,
    });
  }
}
