import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdapterFailureCategory, OpenTableAdapterError } from "../src/opentable/errors.js";
import type { RestaurantSearchQuery } from "../src/opentable/adapter.js";
import type { SafeSearchResults } from "../src/opentable/browser/search-types.js";
import { FileTargetStore } from "../src/storage/file-target-store.js";
import { UiServer, type UiRuntimeStatus } from "../src/ui/server.js";
import { makeTarget } from "./fixtures.js";

interface Harness {
  readonly address: { readonly url: string };
  readonly store: FileTargetStore;
  readonly search: ReturnType<typeof vi.fn>;
  readonly close: () => Promise<void>;
}

const running: Harness[] = [];

async function startHarness(
  searchImpl?: (query: RestaurantSearchQuery) => Promise<SafeSearchResults>,
): Promise<Harness> {
  const store = new FileTargetStore({
    directory: await mkdtemp(path.join(os.tmpdir(), "otb-ui-")),
  });
  const search = vi.fn(
    searchImpl ??
      (async (): Promise<SafeSearchResults> => ({
        results: [
          {
            restaurantId: "70204",
            name: "Catch New York",
            profileUrl: "https://www.opentable.com/r/catch-new-york",
            bookable: true,
          },
        ],
      })),
  );
  const server = new UiServer({
    store,
    adapter: { searchRestaurants: search },
    status: async (): Promise<UiRuntimeStatus> => ({
      bridgeReachable: true,
      authenticated: true,
      mode: "dry-run",
      stateDirectory: "test-state",
    }),
    port: 0,
  });
  const address = await server.start();
  const harness: Harness = {
    address,
    store,
    search,
    close: () => server.close(),
  };
  running.push(harness);
  return harness;
}

afterEach(async () => {
  while (running.length > 0) {
    const harness = running.pop();
    if (harness !== undefined) await harness.close();
  }
});

function jsonPost(
  harness: Harness,
  urlPath: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(harness.address.url + urlPath, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("UiServer", () => {
  it("serves the operator console", async () => {
    const harness = await startHarness();
    const response = await fetch(`${harness.address.url}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("OpenTableBot console");
    expect(html).toContain("/api/targets");
  });

  it("reports bridge and scheduler status", async () => {
    const harness = await startHarness();
    const response = await fetch(`${harness.address.url}/api/status`);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      readonly ok: boolean;
      readonly status: UiRuntimeStatus;
    };
    expect(payload.ok).toBe(true);
    expect(payload.status.bridgeReachable).toBe(true);
    expect(payload.status.mode).toBe("dry-run");
  });

  it("searches through the paired session", async () => {
    const harness = await startHarness();
    const response = await fetch(
      `${harness.address.url}/api/search?term=Catch&date=2026-10-23&time=17%3A00&partySize=2`,
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      readonly results: readonly { readonly restaurantId: string }[];
    };
    expect(payload.results.map((result) => result.restaurantId)).toEqual(["70204"]);
    expect(harness.search).toHaveBeenCalledWith({
      term: "Catch",
      date: "2026-10-23",
      time: "17:00",
      partySize: 2,
    });
  });

  it("rejects a search without a term", async () => {
    const harness = await startHarness();
    const response = await fetch(`${harness.address.url}/api/search?term=`);
    expect(response.status).toBe(400);
    expect(harness.search).not.toHaveBeenCalled();
  });

  it("maps a missing browser session to a conflict", async () => {
    const harness = await startHarness(async () => {
      throw new OpenTableAdapterError(
        AdapterFailureCategory.AUTHENTICATION_REQUIRED,
        "Sign in to OpenTable",
      );
    });
    const response = await fetch(`${harness.address.url}/api/search?term=Catch`);
    expect(response.status).toBe(409);
    const payload = (await response.json()) as {
      readonly error: { readonly category: string };
    };
    expect(payload.error.category).toBe("AUTHENTICATION_REQUIRED");
  });

  it("maps a transient transport failure to an unavailable service", async () => {
    const harness = await startHarness(async () => {
      throw new OpenTableAdapterError(
        AdapterFailureCategory.TRANSIENT_TRANSPORT,
        "Bridge connection closed",
      );
    });
    const response = await fetch(`${harness.address.url}/api/search?term=Catch`);
    expect(response.status).toBe(503);
  });

  it("creates a draft task and lists it", async () => {
    const harness = await startHarness();
    const created = await jsonPost(harness, "/api/targets", {
      target: { ...makeTarget(), id: undefined },
      arm: false,
    });
    expect(created.status).toBe(201);
    const createdPayload = (await created.json()) as {
      readonly target: {
        readonly state: string;
        readonly version: number;
        readonly target: { readonly id: string };
      };
    };
    expect(createdPayload.target.state).toBe("DRAFT");
    expect(createdPayload.target.version).toBe(1);
    expect(createdPayload.target.target.id).toMatch(/^task-/u);

    const listed = await fetch(`${harness.address.url}/api/targets`);
    const listedPayload = (await listed.json()) as {
      readonly targets: readonly { readonly target: { readonly id: string } }[];
    };
    expect(listedPayload.targets).toHaveLength(1);
  });

  it("creates an armed task when requested", async () => {
    const harness = await startHarness();
    const response = await jsonPost(harness, "/api/targets", {
      target: makeTarget(),
      arm: true,
    });
    expect(response.status).toBe(201);
    const payload = (await response.json()) as {
      readonly target: { readonly state: string };
    };
    expect(payload.target.state).toBe("ARMED");
  });

  it("rejects an invalid task definition", async () => {
    const harness = await startHarness();
    const response = await jsonPost(harness, "/api/targets", {
      target: { ...makeTarget(), partySize: 0 },
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as {
      readonly error: { readonly issues: readonly unknown[] };
    };
    expect(payload.error.issues.length).toBeGreaterThan(0);
  });

  it("rejects a duplicate task id", async () => {
    const harness = await startHarness();
    await jsonPost(harness, "/api/targets", { target: makeTarget() });
    const duplicate = await jsonPost(harness, "/api/targets", { target: makeTarget() });
    expect(duplicate.status).toBe(409);
  });

  it("arms and pauses a task with a version guard", async () => {
    const harness = await startHarness();
    await jsonPost(harness, "/api/targets", { target: makeTarget() });

    const armed = await jsonPost(harness, "/api/targets/target-1/state", {
      action: "arm",
      version: 1,
    });
    expect(armed.status).toBe(200);
    expect(((await armed.json()) as { target: { state: string } }).target.state).toBe(
      "ARMED",
    );

    const paused = await jsonPost(harness, "/api/targets/target-1/state", {
      action: "pause",
      version: 2,
    });
    const pausedPayload = (await paused.json()) as {
      readonly target: { readonly state: string; readonly pauseReason: string };
    };
    expect(pausedPayload.target.state).toBe("PAUSED");
    expect(pausedPayload.target.pauseReason).toContain("operator console");

    const stale = await jsonPost(harness, "/api/targets/target-1/state", {
      action: "arm",
      version: 2,
    });
    expect(stale.status).toBe(409);
  });

  it("rejects an invalid state transition", async () => {
    const harness = await startHarness();
    await harness.store.save(
      {
        target: makeTarget(),
        state: "BOOKED",
        version: 0,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
      0,
    );
    const response = await jsonPost(harness, "/api/targets/target-1/state", {
      action: "pause",
      version: 1,
    });
    expect(response.status).toBe(409);
    const payload = (await response.json()) as {
      readonly error: { readonly reason: string };
    };
    expect(payload.error.reason).toBe("INVALID_TRANSITION");
  });

  it("removes a task only at the current version", async () => {
    const harness = await startHarness();
    await jsonPost(harness, "/api/targets", { target: makeTarget() });

    const stale = await fetch(`${harness.address.url}/api/targets/target-1?version=0`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
    });
    expect(stale.status).toBe(409);

    const removed = await fetch(`${harness.address.url}/api/targets/target-1?version=1`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
    });
    expect(removed.status).toBe(200);
    expect(await harness.store.get("target-1")).toBeUndefined();

    const missing = await fetch(`${harness.address.url}/api/targets/target-1?version=1`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
    });
    expect(missing.status).toBe(404);
  });

  // The server rejects non-JSON mutations, so the console must set the header on
  // every mutation, including bodyless ones such as DELETE.
  it("serves a console that sends JSON on bodyless mutations", async () => {
    const harness = await startHarness();
    const html = await (await fetch(`${harness.address.url}/`)).text();
    expect(html).toContain('(init.method || "GET") !== "GET"');
    expect(html).toContain('init.headers = { "content-type": "application/json" };');
  });

  it("requires a JSON content type for mutations", async () => {
    const harness = await startHarness();
    const response = await fetch(`${harness.address.url}/api/targets`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "target=1",
    });
    expect(response.status).toBe(415);
  });

  it("rejects a cross-origin mutation", async () => {
    const harness = await startHarness();
    const response = await jsonPost(harness, "/api/targets", { target: makeTarget() }, {
      origin: "http://evil.example",
    });
    expect(response.status).toBe(403);
    expect(await harness.store.list()).toHaveLength(0);
  });

  it("rejects malformed JSON", async () => {
    const harness = await startHarness();
    const response = await fetch(`${harness.address.url}/api/targets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    expect(response.status).toBe(400);
  });

  it("returns 404 for an unknown endpoint", async () => {
    const harness = await startHarness();
    const response = await fetch(`${harness.address.url}/api/unknown`);
    expect(response.status).toBe(404);
  });
});
