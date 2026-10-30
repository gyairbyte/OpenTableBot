import { LocalNotifier } from "../notifications/local-notifier.js";
import { BrowserBridgeOpenTableBookingAdapter } from "../opentable/bridge/booking-adapter.js";
import { OpenTableBridgeClient } from "../opentable/bridge/client.js";
import { loadCredential } from "../opentable/bridge/credential-store.js";
import { DEFAULT_BRIDGE_PORT } from "../opentable/bridge/protocol.js";
import {
  DEFAULT_READINESS_INTERVAL_MS,
  describeReadiness,
} from "../opentable/bridge/readiness.js";
import { OpenTableAdapterError } from "../opentable/errors.js";
import { registerWindowsTask } from "../platform/windows-scheduled-task.js";
import { ControlledBookingEngine } from "../runner/controlled-booking-engine.js";
import { ReservationScheduler } from "../runner/scheduler.js";
import {
  FileTargetStore,
  targetStateDirectory,
} from "../storage/file-target-store.js";
import {
  describeSchedulerLock,
  readSchedulerLock,
} from "../storage/scheduler-lock.js";
import { DEFAULT_UI_PORT, UiServer, type UiRuntimeStatus } from "./server.js";
import { SchedulerTickLoop } from "./tick-loop.js";

function configuredBridgePort(): number {
  const value = process.env.OPENTABLE_BRIDGE_PORT;
  if (value === undefined) return DEFAULT_BRIDGE_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("OPENTABLE_BRIDGE_PORT must be an integer from 1 through 65535");
  }
  return port;
}

function parseFlags(args: readonly string[]): ReadonlyMap<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; ) {
    const key = args[index];
    const value = args[index + 1];
    if (key === "--execute") {
      flags.set("execute", "true");
      index += 1;
      continue;
    }
    if (key === "--dry-run") {
      flags.set("execute", "false");
      index += 1;
      continue;
    }
    if (
      key === undefined ||
      !key.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new Error(`Expected --name value arguments; received ${key ?? "end of input"}`);
    }
    flags.set(key.slice(2), value);
    index += 2;
  }
  return flags;
}

function portFlag(flags: ReadonlyMap<string, string>): number {
  const raw = flags.get("port");
  if (raw === undefined) return DEFAULT_UI_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("--port must be an integer from 0 through 65535");
  }
  return port;
}

function tickIntervalMs(flags: ReadonlyMap<string, string>): number {
  const raw = flags.get("tick-seconds");
  if (raw === undefined) return 5_000;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("--tick-seconds must be a positive number");
  }
  return seconds * 1_000;
}

function warmUpLeadMs(flags: ReadonlyMap<string, string>): number {
  const raw = flags.get("warm-up-seconds");
  if (raw === undefined) return 180_000;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("--warm-up-seconds must be a positive number");
  }
  return seconds * 1_000;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown operator console failure";
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  let execute = flags.get("execute") !== "false";

  const credential = await loadCredential();
  const client = new OpenTableBridgeClient({
    credential,
    port: configuredBridgePort(),
  });
  const adapter = new BrowserBridgeOpenTableBookingAdapter(client, {
    onDiagnostic: (message) => console.warn(message),
  });
  const store = new FileTargetStore();
  const notifier = new LocalNotifier();
  const engine = new ControlledBookingEngine(
    { adapter, store, notifier },
    {
      execute: () => execute,
      availabilityAttempts: 3,
      availabilityRetryDelayMs: 250,
    },
  );
  const scheduler = new ReservationScheduler(engine, adapter, store, notifier, {
    warmUpLeadMs: warmUpLeadMs(flags),
    readinessPollMs: DEFAULT_READINESS_INTERVAL_MS,
    readiness: async () => {
      const pong = await client.ping();
      const ready = pong.extensionConnected && pong.pageReady;
      return {
        ready,
        detail: describeReadiness({
          ready,
          attempts: 1,
          extensionConnected: pong.extensionConnected,
          pageReady: pong.pageReady,
          ...(pong.pageUrl === undefined ? {} : { pageUrl: pong.pageUrl }),
        }),
      };
    },
  });
  const stateDirectory = targetStateDirectory();
  // The console never takes the scheduler lock, so it can never block an
  // unattended drop. It stands down whenever another process owns the run.
  const loop = new SchedulerTickLoop(scheduler, {
    intervalMs: tickIntervalMs(flags),
    onError: (message) => console.warn(`Scheduler tick failed: ${message}`),
    blockedBy: async () => {
      const holder = await readSchedulerLock(stateDirectory);
      if (holder === undefined || holder.pid === process.pid) return undefined;
      return `An unattended scheduler owns this drop: ${describeSchedulerLock(holder)}. This console is not running targets.`;
    },
  });

  try {
    await adapter.start();
  } catch (error) {
    console.warn(
      `Bridge is not reachable yet (${describe(error)}). Start the bridge and keep an OpenTable tab open.`,
    );
  }

  const server = new UiServer({
    store,
    adapter,
    port: portFlag(flags),
    status: async (): Promise<UiRuntimeStatus> => {
      let bridgeReachable = false;
      try {
        await client.ping();
        bridgeReachable = true;
      } catch {
        bridgeReachable = false;
      }
      let authenticated = false;
      if (bridgeReachable) {
        try {
          authenticated = (await adapter.checkAuthentication()).authenticated;
        } catch {
          authenticated = false;
        }
      }
      return {
        bridgeReachable,
        authenticated,
        mode: execute ? "execute" : "dry-run",
        stateDirectory,
        ...loop.status(),
      };
    },
    setMode: (mode) => {
      execute = mode === "execute";
    },
    runTargetNow: (record) => loop.runTargetNow(record),
    createWindowsTask: async (record, restaurantUrl) =>
      registerWindowsTask(record.target, {
        restaurantUrl,
        peers: (await store.listRunnable()).map((peer) => peer.target),
        mode: execute ? "execute" : "dry-run",
        warmUpSeconds: 600,
        availabilityAttempts: 3,
        availabilityRetryDelayMs: 250,
      }),
  });

  const address = await server.start();
  loop.start();
  console.log(`Operator console: ${address.url}`);
  console.log(
    execute
      ? "Booking mode: CONTROLLED_WRITE (armed tasks submit real reservations)"
      : "Booking mode: DRY_RUN (no reservation is submitted)",
  );
  console.log(`Target state directory: ${stateDirectory}`);
  console.log("Press Ctrl+C to stop.");

  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await loop.stop();
  await server.close();
  await adapter.close();
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
    console.error(describe(error));
  }
  process.exitCode = 1;
});
