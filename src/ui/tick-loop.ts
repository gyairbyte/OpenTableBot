import type { ReservationScheduler } from "../runner/scheduler.js";

export interface SchedulerTickLoopOptions {
  /** Tick interval. Default 5 s. */
  readonly intervalMs?: number;
  readonly now?: () => Date;
  readonly onError?: (message: string) => void;
}

const DEFAULT_INTERVAL_MS = 5_000;

/**
 * Drives the reservation scheduler on an interval for the operator console.
 * Ticks never overlap, so a slow warm-up run cannot be started twice.
 */
export class SchedulerTickLoop {
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private readonly onError: (message: string) => void;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private lastTickAt: string | undefined;
  private lastTickError: string | undefined;

  constructor(
    private readonly scheduler: Pick<ReservationScheduler, "runDueTargets">,
    options: SchedulerTickLoopOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError ?? (() => undefined);
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

  status(): { readonly lastTickAt?: string; readonly lastTickError?: string } {
    return {
      ...(this.lastTickAt === undefined ? {} : { lastTickAt: this.lastTickAt }),
      ...(this.lastTickError === undefined ? {} : { lastTickError: this.lastTickError }),
    };
  }
}
