import { RUNNABLE_TARGET_STATES } from "../../domain/target-state.js";
import { LocalNotifier } from "../../notifications/local-notifier.js";
import { ControlledBookingEngine } from "../../runner/controlled-booking-engine.js";
import { ReservationScheduler } from "../../runner/scheduler.js";
import { FileTargetStore } from "../../storage/file-target-store.js";
import type { TargetRecord, TargetStore } from "../../storage/target-store.js";
import { OpenTableAdapterError } from "../errors.js";
import { BrowserBridgeOpenTableBookingAdapter } from "./booking-adapter.js";
import { OpenTableBridgeClient } from "./client.js";
import { loadCredential } from "./credential-store.js";
import { DEFAULT_BRIDGE_PORT } from "./protocol.js";

function configuredPort(): number {
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

function positiveNumber(
  flags: ReadonlyMap<string, string>,
  name: string,
  fallback: number,
): number {
  const raw = flags.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} must be a positive number`);
  }
  return value;
}

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
  const flags = parseFlags(process.argv.slice(2));
  const targetId = flags.get("target-id");
  const execute = flags.get("execute") === "true";
  const tickMs = positiveNumber(flags, "tick-seconds", 5) * 1_000;
  const maxRuntimeMs = positiveNumber(flags, "max-runtime-minutes", 30) * 60_000;

  const credential = await loadCredential();
  const client = new OpenTableBridgeClient({ credential, port: configuredPort() });
  const adapter = new BrowserBridgeOpenTableBookingAdapter(client, {
    onDiagnostic: (message) => console.warn(message),
  });
  const store = new FileTargetStore();
  const notifier = new LocalNotifier();
  const engine = new ControlledBookingEngine(
    { adapter, store, notifier },
    { execute },
  );
  const scheduler = new ReservationScheduler(engine, adapter, store, notifier);

  console.log(
    execute
      ? "Scheduler mode: CONTROLLED_WRITE (unattended submission enabled)"
      : "Scheduler mode: DRY_RUN (no inventory is locked)",
  );
  await adapter.start();
  const deadline = Date.now() + maxRuntimeMs;
  try {
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
