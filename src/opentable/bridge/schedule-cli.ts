import { RUNNABLE_TARGET_STATES } from "../../domain/target-state.js";
import { LocalNotifier } from "../../notifications/local-notifier.js";
import { ControlledBookingEngine } from "../../runner/controlled-booking-engine.js";
import { ReservationScheduler } from "../../runner/scheduler.js";
import {
  FileTargetStore,
  targetStateDirectory,
} from "../../storage/file-target-store.js";
import {
  acquireSchedulerLock,
  describeSchedulerLock,
  releaseSchedulerLock,
} from "../../storage/scheduler-lock.js";
import type { TargetRecord, TargetStore } from "../../storage/target-store.js";
import { OpenTableAdapterError } from "../errors.js";
import { BrowserBridgeOpenTableBookingAdapter } from "./booking-adapter.js";
import { OpenTableBridgeClient } from "./client.js";
import { loadCredential } from "./credential-store.js";
import {
  DEFAULT_READINESS_INTERVAL_MS,
  describeReadiness,
  waitForBridgeReadiness,
} from "./readiness.js";
import { parseScheduleCliOptions } from "./schedule-options.js";

async function pendingTargets(
  store: TargetStore,
  targetId: string | undefined,
): Promise<readonly TargetRecord[]> {
  if (targetId === undefined) return store.listRunnable();
  const record = await store.get(targetId);
  if (record === undefined || !RUNNABLE_TARGET_STATES.includes(record.state)) {
    return [];
  }
  return [record];
}

async function main(): Promise<void> {
  const options = parseScheduleCliOptions(process.argv.slice(2));
  const {
    targetId,
    execute,
    tickMs,
    maxRuntimeMs,
    warmUpLeadMs,
    readinessMs,
    availabilityAttempts,
    availabilityRetryDelayMs,
  } = options;

  const credential = await loadCredential();
  const client = new OpenTableBridgeClient({ credential, port: options.bridgePort });
  const adapter = new BrowserBridgeOpenTableBookingAdapter(client, {
    onDiagnostic: (message) => console.warn(message),
  });
  const store = new FileTargetStore();
  const notifier = new LocalNotifier();
  const engine = new ControlledBookingEngine(
    { adapter, store, notifier },
    {
      execute,
      availabilityAttempts,
      availabilityRetryDelayMs,
    },
  );

  // One unattended scheduler per state directory. A second process would race
  // the first through the same targets at the same drop.
  const stateDirectory = targetStateDirectory();
  const lock = await acquireSchedulerLock(stateDirectory, `schedule-cli ${targetId ?? "all"}`);
  if ("heldBy" in lock) {
    console.error(
      `Another scheduler already owns ${lock.path}: ${describeSchedulerLock(lock.heldBy)}`,
    );
    console.error("Stop that process, or wait for it to finish, then run this again.");
    process.exitCode = 1;
    return;
  }

  const scheduler = new ReservationScheduler(engine, adapter, store, notifier, {
    warmUpLeadMs,
    readinessPollMs: DEFAULT_READINESS_INTERVAL_MS,
    readiness: async () => {
      const pong = await client.ping();
      return {
        ready: pong.extensionConnected && pong.pageReady,
        detail: describeReadiness({
          ready: pong.extensionConnected && pong.pageReady,
          attempts: 1,
          extensionConnected: pong.extensionConnected,
          pageReady: pong.pageReady,
          ...(pong.pageUrl === undefined ? {} : { pageUrl: pong.pageUrl }),
        }),
      };
    },
  });

  console.log(
    execute
      ? "Scheduler mode: CONTROLLED_WRITE (unattended submission enabled)"
      : "Scheduler mode: DRY_RUN (no inventory is locked)",
  );
  console.log(`Waiting up to ${readinessMs / 1_000}s for Chrome and the extension.`);
  try {
    // The bridge may still be starting on a machine that just resumed, so an
    // initial connection failure is not fatal: the readiness poll reconnects.
    try {
      await adapter.start();
    } catch (error) {
      console.warn(
        `Bridge is not reachable yet (${error instanceof Error ? error.message : "unknown error"}). Still waiting.`,
      );
    }
    const readiness = await waitForBridgeReadiness({
      ping: () => client.ping(),
      timeoutMs: readinessMs,
      onProgress: (message) => console.log(`Readiness: ${message}`),
    });
    console.log(`Readiness after ${readiness.attempts} check(s): ${describeReadiness(readiness)}`);
    if (!readiness.ready) {
      console.warn(
        "Proceeding without a ready browser. Targets will pause with the readiness reason rather than book.",
      );
    }

    const deadline = Date.now() + maxRuntimeMs;
    for (;;) {
      const records = await pendingTargets(store, targetId);
      if (records.length === 0) {
        console.log("No runnable targets remain.");
        return;
      }
      for (const record of records) await scheduler.runTarget(record);
      if (Date.now() >= deadline) {
        console.warn("Scheduler reached its maximum runtime; exiting.");
        return;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, tickMs);
      });
    }
  } finally {
    await adapter.close();
    await releaseSchedulerLock(lock);
  }
}

void main().catch((error: unknown) => {
  if (error instanceof OpenTableAdapterError) {
    console.error(
      JSON.stringify({
        ok: false,
        category: error.category,
        disposition: error.disposition,
        message: error.message,
      }),
    );
  } else {
    console.error(error instanceof Error ? error.message : "Unknown scheduler failure");
  }
  process.exitCode = 1;
});
