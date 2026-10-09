import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const lockFileSchema = z.strictObject({
  pid: z.number().int().positive(),
  owner: z.string().min(1).max(200),
  acquiredAt: z.string().datetime({ offset: true }),
});

export type SchedulerLockInfo = z.infer<typeof lockFileSchema>;

export interface SchedulerLock extends SchedulerLockInfo {
  readonly path: string;
}

export interface SchedulerLockConflict {
  readonly heldBy: SchedulerLockInfo;
  readonly path: string;
}

export const SCHEDULER_LOCK_FILE = "scheduler.lock";

export function schedulerLockPath(directory: string): string {
  return path.join(directory, SCHEDULER_LOCK_FILE);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Reads the current lock holder. A lock whose process is gone is reported as
 * absent, so a crash or a hard power-off never wedges future runs.
 */
export async function readSchedulerLock(
  directory: string,
): Promise<SchedulerLockInfo | undefined> {
  let raw: string;
  try {
    raw = await readFile(schedulerLockPath(directory), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: SchedulerLockInfo;
  try {
    parsed = lockFileSchema.parse(JSON.parse(raw) as unknown);
  } catch {
    // A truncated or hand-edited lock is treated as absent rather than fatal.
    return undefined;
  }
  if (parsed.pid === process.pid) return parsed;
  return isProcessAlive(parsed.pid) ? parsed : undefined;
}

/**
 * Exclusive lock for an unattended scheduler run. Only one unattended process
 * may drive the scheduler against a state directory, so a second one refuses
 * instead of racing the first through the same targets.
 */
export async function acquireSchedulerLock(
  directory: string,
  owner: string,
): Promise<SchedulerLock | SchedulerLockConflict> {
  const filePath = schedulerLockPath(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const existing = await readSchedulerLock(directory);
  if (existing !== undefined) {
    return { heldBy: existing, path: filePath };
  }

  const info: SchedulerLockInfo = {
    pid: process.pid,
    owner,
    acquiredAt: new Date().toISOString(),
  };

  // `wx` makes creation the atomic claim, so two processes starting together
  // cannot both believe they own the lock.
  let handle;
  try {
    handle = await open(filePath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // The stale lock we just cleared was recreated, or another process won the
    // race between the read and the create. Re-read to name the real holder.
    const winner = await readSchedulerLock(directory);
    if (winner !== undefined) return { heldBy: winner, path: filePath };
    await writeFile(filePath, `${JSON.stringify(info)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return { ...info, path: filePath };
  }

  try {
    await handle.writeFile(`${JSON.stringify(info)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  return { ...info, path: filePath };
}

/** Removes the lock only if this process still owns it. */
export async function releaseSchedulerLock(lock: SchedulerLock): Promise<void> {
  const current = await readSchedulerLock(path.dirname(lock.path));
  if (current !== undefined && current.pid !== process.pid) return;
  try {
    await unlink(lock.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function describeSchedulerLock(info: SchedulerLockInfo): string {
  return `${info.owner} (pid ${info.pid}, since ${info.acquiredAt})`;
}
