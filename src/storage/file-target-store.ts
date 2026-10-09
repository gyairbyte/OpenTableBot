import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { BookingTargetSchema } from "../domain/booking-target.js";
import { BookingConfirmationSchema } from "../domain/reservation-slot.js";
import {
  RUNNABLE_TARGET_STATES,
  TargetStateSchema,
} from "../domain/target-state.js";
import type { TargetRecord, TargetStore } from "./target-store.js";

const storedRecordSchema = z.strictObject({
  version: z.number().int().nonnegative(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  state: TargetStateSchema,
  target: BookingTargetSchema,
  pauseReason: z.string().min(1).optional(),
  confirmation: BookingConfirmationSchema.optional(),
});

const storedFileSchema = z.strictObject({
  version: z.literal(1),
  records: z.array(storedRecordSchema),
});

type StoredRecord = z.infer<typeof storedRecordSchema>;

export class TargetStoreConflictError extends Error {
  constructor(
    readonly targetId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `Target ${targetId} was modified concurrently (expected version ${expectedVersion}, found ${actualVersion})`,
    );
    this.name = "TargetStoreConflictError";
  }
}

export function targetStateDirectory(override?: string): string {
  const configured = override ?? process.env.OPENTABLE_BOT_STATE_DIRECTORY;
  return path.resolve(configured?.trim() || ".local/state");
}

export function targetStatePath(directory = targetStateDirectory()): string {
  return path.join(directory, "targets.json");
}

function toTargetRecord(record: StoredRecord): TargetRecord {
  return {
    target: record.target,
    state: record.state,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.pauseReason === undefined ? {} : { pauseReason: record.pauseReason }),
    ...(record.confirmation === undefined
      ? {}
      : { confirmation: record.confirmation }),
  };
}

async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

export interface FileTargetStoreOptions {
  readonly directory?: string;
  readonly now?: () => Date;
}

/**
 * Durable, version-checked JSON store for scheduled booking targets. Writes are
 * atomic (temp file plus rename) and serialized in-process so a read-modify-
 * write cycle cannot interleave within one scheduler process.
 */
export class FileTargetStore implements TargetStore {
  private readonly filePath: string;
  private readonly now: () => Date;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: FileTargetStoreOptions = {}) {
    const directory =
      options.directory === undefined
        ? targetStateDirectory()
        : targetStateDirectory(options.directory);
    this.filePath = targetStatePath(directory);
    this.now = options.now ?? (() => new Date());
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async readAll(): Promise<Map<string, TargetRecord>> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw error;
    }
    const parsed = storedFileSchema.parse(JSON.parse(raw) as unknown);
    return new Map(
      parsed.records.map((record) => [record.target.id, toTargetRecord(record)]),
    );
  }

  private async writeAll(records: Iterable<TargetRecord>): Promise<void> {
    const payload = { version: 1, records: [...records] };
    storedFileSchema.parse(payload);
    await writeFileAtomic(this.filePath, `${JSON.stringify(payload, null, 2)}\n`);
  }

  async get(targetId: string): Promise<TargetRecord | undefined> {
    return (await this.readAll()).get(targetId);
  }

  async save(record: TargetRecord, expectedVersion: number): Promise<TargetRecord> {
    return this.enqueue(async () => {
      const records = await this.readAll();
      const existing = records.get(record.target.id);
      const actualVersion = existing?.version ?? 0;
      if (actualVersion !== expectedVersion) {
        throw new TargetStoreConflictError(
          record.target.id,
          expectedVersion,
          actualVersion,
        );
      }
      const saved: TargetRecord = {
        ...record,
        version: actualVersion + 1,
        createdAt: existing?.createdAt ?? record.createdAt,
        updatedAt: this.now().toISOString(),
      };
      records.set(record.target.id, saved);
      await this.writeAll(records.values());
      return saved;
    });
  }

  async listRunnable(): Promise<readonly TargetRecord[]> {
    const runnable = new Set<string>(RUNNABLE_TARGET_STATES);
    return [...(await this.readAll()).values()].filter((record) =>
      runnable.has(record.state),
    );
  }

  async list(): Promise<readonly TargetRecord[]> {
    return [...(await this.readAll()).values()];
  }

  async remove(targetId: string, expectedVersion: number): Promise<void> {
    return this.enqueue(async () => {
      const records = await this.readAll();
      const existing = records.get(targetId);
      if (existing === undefined) {
        throw new Error(`Target ${targetId} was not found`);
      }
      if (existing.version !== expectedVersion) {
        throw new TargetStoreConflictError(targetId, expectedVersion, existing.version);
      }
      records.delete(targetId);
      await this.writeAll(records.values());
    });
  }
}
