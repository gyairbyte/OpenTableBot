import { DEFAULT_BRIDGE_PORT } from "./protocol.js";

export interface ScheduleCliOptions {
  readonly targetId: string | undefined;
  readonly execute: boolean;
  readonly tickMs: number;
  readonly maxRuntimeMs: number;
  readonly warmUpLeadMs: number;
  readonly readinessMs: number;
  readonly bridgePort: number;
}

export const DEFAULT_WARM_UP_SECONDS = 180;
export const DEFAULT_MAX_RUNTIME_MINUTES = 30;
export const DEFAULT_TICK_SECONDS = 5;

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

export function configuredBridgePort(): number {
  const value = process.env.OPENTABLE_BRIDGE_PORT;
  if (value === undefined) return DEFAULT_BRIDGE_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("OPENTABLE_BRIDGE_PORT must be an integer from 1 through 65535");
  }
  return port;
}

/**
 * Parses the scheduler CLI flags into absolute durations. Every duration is
 * converted to milliseconds here, once, so a caller cannot mistake seconds for
 * milliseconds when it hands a value to a deadline.
 */
export function parseScheduleCliOptions(args: readonly string[]): ScheduleCliOptions {
  const flags = parseFlags(args);
  const warmUpSeconds = positiveNumber(flags, "warm-up-seconds", DEFAULT_WARM_UP_SECONDS);
  return {
    targetId: flags.get("target-id"),
    execute: flags.get("execute") === "true",
    tickMs: positiveNumber(flags, "tick-seconds", DEFAULT_TICK_SECONDS) * 1_000,
    maxRuntimeMs:
      positiveNumber(flags, "max-runtime-minutes", DEFAULT_MAX_RUNTIME_MINUTES) * 60_000,
    warmUpLeadMs: warmUpSeconds * 1_000,
    readinessMs: positiveNumber(flags, "readiness-seconds", warmUpSeconds) * 1_000,
    bridgePort: configuredBridgePort(),
  };
}
