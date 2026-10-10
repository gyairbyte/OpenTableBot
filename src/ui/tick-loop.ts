import type { ReservationScheduler } from "../runner/scheduler.js";
import type { TargetRecord } from "../storage/target-store.js";

export interface SchedulerTickLoopOptions {
  /** Tick interval. Default 5 s. */
  readonly intervalMs?: number;
  readonly now?: () => Date;
  readonly onError?: (message: string) => void;
  /**
   * Consulted before each pass. Returning a reason skips the pass, which lets
   * the console stand down while an unattended scheduled run owns the drop.
   */
  readonly blockedBy?: () => Promise<string | undefined>;
}

const DEFAULT_INTERVAL_MS = 5_000;

type SchedulerTickLoopScheduler = Pick<ReservationScheduler, "runDueTargets"> &
  Partial<Pick<ReservationScheduler, "runTargetNow">>;

/**
 * Drives the reservation scheduler on an interval for the operator console.
 * Ticks never overlap, so a slow warm-up run cannot be started twice.
 */
export class SchedulerTickLoop {
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private readonly onError: (message: string) => void;
  private readonly blockedBy: (() => Promise<string | undefined>) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private lastTickAt: string | undefined;
  private lastTickError: string | undefined;
  private lastSkippedReason: string | undefined;

  constructor(
    private readonly scheduler: SchedulerTickLoopScheduler,
    options: SchedulerTickLoopOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError ?? (() => undefined);
    this.blockedBy = options.blockedBy;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.tickOnce();
    }, this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.inFlight;
  }

  /** Runs at most one scheduler pass; concurrent calls share the in-flight pass. */
  async tickOnce(): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight;
    const pass = (async () => {
      try {
        const blocked = await this.blockedBy?.();
        if (blocked !== undefined) {
          this.lastSkippedReason = blocked;
          return;
        }
        this.lastSkippedReason = undefined;
        await this.scheduler.runDueTargets();
        this.lastTickAt = this.now().toISOString();
        this.lastTickError = undefined;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown scheduler failure";
        this.lastTickError = message;
        this.onError(message);
      }
    })();
    this.inFlight = pass;
    try {
      await pass;
    } finally {
      this.inFlight = undefined;
    }
  }

  async runTargetNow(record: TargetRecord): Promise<void> {
    if (this.inFlight !== undefined) {
      throw new Error("The scheduler is already running a pass");
    }
    if (this.scheduler.runTargetNow === undefined) {
      throw new Error("Immediate scheduler runs are unavailable");
    }
    const pass = (async () => {
      const blocked = await this.blockedBy?.();
      if (blocked !== undefined) throw new Error(blocked);
      await this.scheduler.runTargetNow?.(record);
    })();
    this.inFlight = pass;
    try {
      await pass;
    } finally {
      this.inFlight = undefined;
    }
  }

  status(): {
    readonly lastTickAt?: string;
    readonly lastTickError?: string;
    readonly schedulerSkippedReason?: string;
  } {
    return {
      ...(this.lastTickAt === undefined ? {} : { lastTickAt: this.lastTickAt }),
      ...(this.lastTickError === undefined ? {} : { lastTickError: this.lastTickError }),
      ...(this.lastSkippedReason === undefined
        ? {}
        : { schedulerSkippedReason: this.lastSkippedReason }),
    };
  }
}
