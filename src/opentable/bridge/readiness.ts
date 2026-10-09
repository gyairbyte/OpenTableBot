import type { Pong } from "./protocol.js";

/**
 * Readiness means the bridge can actually serve a booking: the extension is
 * connected and at least one eligible OpenTable page is bound. A `PING` answers
 * both flags without dispatching anything, so this is a pure read.
 */
export interface BridgeReadinessOptions {
  readonly ping: () => Promise<Pong>;
  /** Total time to keep polling. Zero performs exactly one check. */
  readonly timeoutMs: number;
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Called only when the observed state changes, so logs stay quiet. */
  readonly onProgress?: (message: string) => void;
}

export interface BridgeReadinessReport {
  readonly ready: boolean;
  readonly attempts: number;
  readonly extensionConnected: boolean;
  readonly pageReady: boolean;
  readonly pageUrl?: string;
  /** Set when the last attempt could not reach the bridge at all. */
  readonly lastError?: string;
}

export const DEFAULT_READINESS_INTERVAL_MS = 3_000;

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function describeObservation(report: {
  readonly extensionConnected: boolean;
  readonly pageReady: boolean;
  readonly pageUrl?: string;
  readonly lastError?: string;
}): string {
  if (report.lastError !== undefined) {
    return `bridge unreachable (${report.lastError})`;
  }
  const parts = [
    report.extensionConnected ? "extension connected" : "extension not connected",
    report.pageReady ? "OpenTable page ready" : "no eligible OpenTable page",
  ];
  if (report.pageUrl !== undefined) parts.push(report.pageUrl);
  return parts.join(", ");
}

/**
 * Polls the bridge until the extension and an eligible page are both ready, or
 * the timeout elapses. Connection failures are retried rather than thrown so a
 * machine that just woke up can finish starting Chrome and the extension.
 */
export async function waitForBridgeReadiness(
  options: BridgeReadinessOptions,
): Promise<BridgeReadinessReport> {
  const intervalMs = options.intervalMs ?? DEFAULT_READINESS_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const deadline = now() + Math.max(0, options.timeoutMs);

  let attempts = 0;
  let extensionConnected = false;
  let pageReady = false;
  let pageUrl: string | undefined;
  let lastError: string | undefined;
  let lastObservation: string | undefined;

  for (;;) {
    attempts += 1;
    try {
      const pong = await options.ping();
      extensionConnected = pong.extensionConnected;
      pageReady = pong.pageReady;
      pageUrl = pong.pageUrl;
      lastError = undefined;
    } catch (error) {
      extensionConnected = false;
      pageReady = false;
      pageUrl = undefined;
      lastError = error instanceof Error ? error.message : "Bridge ping failed";
    }

    const observation = describeObservation({
      extensionConnected,
      pageReady,
      ...(pageUrl === undefined ? {} : { pageUrl }),
      ...(lastError === undefined ? {} : { lastError }),
    });
    if (observation !== lastObservation) {
      options.onProgress?.(observation);
      lastObservation = observation;
    }

    if (extensionConnected && pageReady) break;

    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }

  return {
    ready: extensionConnected && pageReady,
    attempts,
    extensionConnected,
    pageReady,
    ...(pageUrl === undefined ? {} : { pageUrl }),
    ...(lastError === undefined ? {} : { lastError }),
  };
}

/** Human-readable summary for a final, non-progress log line. */
export function describeReadiness(report: BridgeReadinessReport): string {
  return describeObservation(report);
}
