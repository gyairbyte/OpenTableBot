import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BookingTarget } from "../domain/booking-target.js";

export type WindowsTaskBookingMode = "dry-run" | "execute";

export interface WindowsTaskRegistration {
  readonly taskName: string;
  readonly dropDate: string;
  readonly dropTime: string;
  readonly restaurantUrl: string;
  readonly mode: WindowsTaskBookingMode;
  readonly warmUpSeconds: number;
  readonly availabilityAttempts: number;
  readonly availabilityRetryDelayMs: number;
  /** Set when one task runs several targets that share a restaurant and release time. */
  readonly groupedTargetIds?: readonly string[];
}

export interface RegisterWindowsTaskOptions {
  readonly restaurantUrl: string;
  /**
   * Other runnable targets in the store. A target that shares its restaurant
   * and release time with any of them is registered as one shared task.
   */
  readonly peers?: readonly BookingTarget[];
  readonly mode: WindowsTaskBookingMode;
  readonly warmUpSeconds?: number;
  readonly availabilityAttempts?: number;
  readonly availabilityRetryDelayMs?: number;
}

function registrationScriptPath(): string {
  const sourcePath = fileURLToPath(
    new URL("../../scripts/register-scheduled-task.ps1", import.meta.url),
  );
  if (existsSync(sourcePath)) return sourcePath;
  const workingTreePath = path.resolve(
    process.cwd(),
    "scripts",
    "register-scheduled-task.ps1",
  );
  if (existsSync(workingTreePath)) return workingTreePath;
  throw new Error("register-scheduled-task.ps1 was not found");
}

function releasePartsAtTimeZone(target: BookingTarget, timeZone: string): {
  readonly date: string;
  readonly time: string;
} {
  if (target.knownReservationReleaseAt === undefined) {
    throw new Error("A known-drop target requires a release time");
  }
  const release = new Date(target.knownReservationReleaseAt);
  if (Number.isNaN(release.getTime())) throw new Error("Release time is invalid");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(release);
  const values = new Map(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  const hour = values.get("hour");
  const minute = values.get("minute");
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined
  ) {
    throw new Error("Could not convert the release time to the restaurant's local time");
  }
  return {
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}`,
  };
}

function taskNameFor(target: BookingTarget): string {
  const suffix = target.id.replace(/[^A-Za-z0-9_-]/gu, "-").slice(0, 160);
  return `OpenTableBot-${suffix}`;
}

export interface WindowsTaskScope {
  readonly taskName: string;
  /** The one target a solo task is bound to; undefined for a shared task. */
  readonly targetId: string | undefined;
  /** Every target a shared task covers; undefined for a solo task. */
  readonly groupedTargetIds: readonly string[] | undefined;
}

function sharesDrop(target: BookingTarget, other: BookingTarget): boolean {
  if (
    other.mode !== "known-drop" ||
    target.knownReservationReleaseAt === undefined ||
    other.knownReservationReleaseAt === undefined
  ) {
    return false;
  }
  return (
    other.restaurant.id === target.restaurant.id &&
    Date.parse(other.knownReservationReleaseAt) === Date.parse(target.knownReservationReleaseAt)
  );
}

/**
 * Two unattended runs would fight over the scheduler lock and the second would
 * miss its drop, so targets that fire at the same moment at the same restaurant
 * get one task that runs them all together. Registering from any of them yields
 * the same task name, so a repeat registration replaces it instead of adding a
 * second competing task.
 */
export function windowsTaskScope(
  target: BookingTarget,
  peers: readonly BookingTarget[] = [],
): WindowsTaskScope {
  const sharing = peers.filter(
    (peer) => peer.id !== target.id && sharesDrop(target, peer),
  );
  if (sharing.length === 0 || target.knownReservationReleaseAt === undefined) {
    return { taskName: taskNameFor(target), targetId: target.id, groupedTargetIds: undefined };
  }
  const restaurant = target.restaurant.id.replace(/[^A-Za-z0-9_-]/gu, "-").slice(0, 80);
  const release = new Date(target.knownReservationReleaseAt)
    .toISOString()
    .replace(/[^0-9TZ]/gu, "");
  return {
    taskName: `OpenTableBot-${restaurant}-${release}`,
    targetId: undefined,
    groupedTargetIds: [target.id, ...sharing.map((peer) => peer.id)].sort(),
  };
}

async function runPowerShell(
  scriptPath: string,
  argumentsList: readonly string[],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        ...argumentsList,
      ],
      { windowsHide: true },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) return resolve();
      reject(
        new Error(
          stderr.trim() ||
            `PowerShell exited with code ${String(code ?? "unknown")}`,
        ),
      );
    });
  });
}

export async function registerWindowsTask(
  target: BookingTarget,
  options: RegisterWindowsTaskOptions,
): Promise<WindowsTaskRegistration> {
  if (process.platform !== "win32") {
    throw new Error("Windows task registration is only available on Windows");
  }
  const release = new Date(target.knownReservationReleaseAt ?? "");
  if (Number.isNaN(release.getTime())) throw new Error("Release time is invalid");
  const warmUpSeconds = options.warmUpSeconds ?? 600;
  if (release.getTime() - warmUpSeconds * 1_000 <= Date.now()) {
    throw new Error("The Windows task warm-up time has already passed");
  }
  const machineTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const releaseParts = releasePartsAtTimeZone(target, machineTimeZone);
  const scope = windowsTaskScope(target, options.peers);
  const taskName = scope.taskName;
  const availabilityAttempts = options.availabilityAttempts ?? 3;
  const availabilityRetryDelayMs = options.availabilityRetryDelayMs ?? 250;
  const args = [
    "-RestaurantUrl",
    options.restaurantUrl,
    "-DropTime",
    releaseParts.time,
    "-DropDate",
    releaseParts.date,
    ...(scope.targetId === undefined ? [] : ["-TargetId", scope.targetId]),
    "-TaskName",
    taskName,
    "-WarmUpSeconds",
    String(warmUpSeconds),
    "-AvailabilityAttempts",
    String(availabilityAttempts),
    "-AvailabilityRetryDelayMs",
    String(availabilityRetryDelayMs),
    options.mode === "execute" ? "-Execute" : "-DryRun",
  ];
  await runPowerShell(registrationScriptPath(), args);
  return {
    taskName,
    dropDate: releaseParts.date,
    dropTime: releaseParts.time,
    restaurantUrl: options.restaurantUrl,
    mode: options.mode,
    warmUpSeconds,
    availabilityAttempts,
    availabilityRetryDelayMs,
    ...(scope.groupedTargetIds === undefined
      ? {}
      : { groupedTargetIds: scope.groupedTargetIds }),
  };
}
