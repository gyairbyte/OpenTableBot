import type { OpenTableReadAdapter } from "../opentable/adapter.js";
import { TargetState, canTransitionTarget } from "../domain/target-state.js";
import type { Notifier } from "../notifications/notifier.js";
import type { TargetRecord, TargetStore } from "../storage/target-store.js";
import type { BookingEngine } from "./booking-engine.js";

export interface ReservationSchedulerOptions {
  /** How long before the drop to begin verifying readiness. Default 60 s. */
  readonly warmUpLeadMs?: number;
  /** Readiness poll interval during warm-up. Default 5 s. */
  readonly readinessPollMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

const DEFAULT_WARM_UP_LEAD_MS = 60_000;
const DEFAULT_READINESS_POLL_MS = 5_000;

/**
 * Bounded known-drop scheduler. For each due `known-drop` target it warms up
 * before the release time, waits until the drop, then delegates exactly one
 * attempt to the engine. It never retries after the drop; transient and
 * safety failures are handled by the engine's fail-closed pause.
 */
export class ReservationScheduler {
  private readonly warmUpLeadMs: number;
  private readonly readinessPollMs: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

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

  async runTarget(record: TargetRecord): Promise<void> {
    const target = record.target;
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
    await this.engine.runOnce(target.id);
  }

  private async waitForReadiness(releaseAt: number): Promise<void> {
    while (this.now() < releaseAt) {
      try {
        if ((await this.adapter.checkAuthentication()).authenticated) return;
      } catch {
        // Not ready yet; keep polling within the warm-up window.
      }
      const remaining = releaseAt - this.now();
      if (remaining <= 0) return;
      await this.sleep(Math.min(this.readinessPollMs, remaining));
    }
  }

  private async pause(record: TargetRecord, reason: string): Promise<void> {
    if (!canTransitionTarget(record.state, TargetState.PAUSED)) return;
    await this.store.save(
      { ...record, state: TargetState.PAUSED, pauseReason: reason },
      record.version,
    );
    await this.notifier.notify({
      type: "target-paused",
      targetId: record.target.id,
      reason,
    });
  }
}
