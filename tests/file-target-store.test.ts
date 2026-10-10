import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TargetState } from "../src/domain/target-state.js";
import {
  FileTargetStore,
  TargetStoreConflictError,
  targetStatePath,
} from "../src/storage/file-target-store.js";
import type { TargetRecord } from "../src/storage/target-store.js";
import { makeTarget } from "./fixtures.js";

async function tempDirectory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "otb-store-"));
}

function record(overrides: Partial<TargetRecord> = {}): TargetRecord {
  return {
    target: makeTarget(),
    state: TargetState.ARMED,
    version: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("FileTargetStore", () => {
  it("persists a new target and reads it back", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    const saved = await store.save(record(), 0);
    expect(saved.version).toBe(1);
    const loaded = await store.get("target-1");
    expect(loaded?.state).toBe("ARMED");
    expect(loaded?.target.restaurant.id).toBe("restaurant-123");
  });

  it("rejects a stale expected version", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    await store.save(record(), 0);
    await expect(
      store.save(record({ state: TargetState.WAITING }), 0),
    ).rejects.toBeInstanceOf(TargetStoreConflictError);
  });

  it("increments the version and preserves createdAt on update", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    const created = await store.save(record(), 0);
    const updated = await store.save(
      record({
        state: TargetState.WAITING,
        createdAt: "2099-01-01T00:00:00.000Z",
      }),
      1,
    );
    expect(updated.version).toBe(2);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.state).toBe("WAITING");
  });

  it("lists only runnable targets", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    await store.save(record(), 0);
    await store.save(
      record({
        target: makeTarget({ id: "target-2" }),
        state: TargetState.BOOKED,
      }),
      0,
    );
    const runnable = await store.listRunnable();
    expect(runnable.map((entry) => entry.target.id)).toEqual(["target-1"]);
  });

  it("fails closed on a corrupt state file", async () => {
    const directory = await tempDirectory();
    await writeFile(targetStatePath(directory), "{ not json", "utf8");
    const store = new FileTargetStore({ directory });
    await expect(store.get("target-1")).rejects.toThrow();
  });

  it("removes a target at the current version", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    await store.save(record(), 0);
    await store.remove("target-1", 1);
    expect(await store.get("target-1")).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it("rejects removal at a stale version", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    await store.save(record(), 0);
    await expect(store.remove("target-1", 0)).rejects.toBeInstanceOf(
      TargetStoreConflictError,
    );
    expect(await store.get("target-1")).toBeDefined();
  });

  it("rejects removal of an unknown target", async () => {
    const store = new FileTargetStore({ directory: await tempDirectory() });
    await expect(store.remove("target-missing", 1)).rejects.toThrow(/not found/u);
  });
});
