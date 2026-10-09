import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BookingTarget } from "../src/domain/booking-target.js";
import type {
  BookingPreview,
  ReservationSlot,
} from "../src/domain/reservation-slot.js";
import { AdapterFailureCategory, OpenTableAdapterError } from "../src/opentable/errors.js";
import type { RestaurantSearchQuery } from "../src/opentable/adapter.js";
import type { SafeSearchResults } from "../src/opentable/browser/search-types.js";
import { FileTargetStore } from "../src/storage/file-target-store.js";
import { UiServer, type UiRuntimeStatus } from "../src/ui/server.js";
import { makePreview, makeSlot, makeTarget } from "./fixtures.js";

interface Harness {
  readonly address: { readonly url: string };
  readonly store: FileTargetStore;
  readonly search: ReturnType<typeof vi.fn>;
  readonly findSlots: ReturnType<typeof vi.fn>;
  readonly getBookingPreview: ReturnType<typeof vi.fn>;
  readonly close: () => Promise<void>;
}

interface HarnessOverrides {
  readonly search?: (query: RestaurantSearchQuery) => Promise<SafeSearchResults>;
  readonly findSlots?: (target: BookingTarget) => Promise<readonly ReservationSlot[]>;
  readonly getBookingPreview?: (
    target: BookingTarget,
    slot: ReservationSlot,
  ) => Promise<BookingPreview>;
}

const running: Harness[] = [];

async function startHarness(overrides: HarnessOverrides = {}): Promise<Harness> {
  const store = new FileTargetStore({
    directory: await mkdtemp(path.join(os.tmpdir(), "otb-ui-")),
  });
  const search = vi.fn(
    overrides.search ??
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
  const findSlots = vi.fn(
    overrides.findSlots ?? (async (): Promise<readonly ReservationSlot[]> => [makeSlot()]),
  );
  const getBookingPreview = vi.fn(
    overrides.getBookingPreview ??
      (async (): Promise<BookingPreview> => makePreview()),
  );
  const server = new UiServer({
    store,
    adapter: { searchRestaurants: search, findSlots, getBookingPreview },
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
    findSlots,
    getBookingPreview,
    close: () => server.close(),
  };
  running.push(harness);
  return harness;
}

function probeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    restaurantId: "70204",
    restaurantName: "Catch New York",
    timeZone: "America/New_York",
    date: "2026-09-01",
    partySize: 2,
    earliest: "17:00",
    latest: "21:00",
    preferred: "19:00",
    ...overrides,
  };
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

function jsonPut(harness: Harness, urlPath: string, body: unknown): Promise<Response> {
  return fetch(harness.address.url + urlPath, {
    method: "PUT",
    headers: { "content-type": "application/json" },
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
    const harness = await startHarness({
      search: async () => {
        throw new OpenTableAdapterError(
          AdapterFailureCategory.AUTHENTICATION_REQUIRED,
          "Sign in to OpenTable",
        );
      },
    });
    const response = await fetch(`${harness.address.url}/api/search?term=Catch`);
    expect(response.status).toBe(409);
    const payload = (await response.json()) as {
      readonly error: { readonly category: string };
    };
    expect(payload.error.category).toBe("AUTHENTICATION_REQUIRED");
  });

  it("maps a transient transport failure to an unavailable service", async () => {
    const harness = await startHarness({
      search: async () => {
        throw new OpenTableAdapterError(
          AdapterFailureCategory.TRANSIENT_TRANSPORT,
          "Bridge connection closed",
        );
      },
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

  it("edits a task definition while preserving its state", async () => {
    const harness = await startHarness();
    await jsonPost(harness, "/api/targets", { target: makeTarget() });

    const response = await jsonPut(harness, "/api/targets/target-1", {
      target: { ...makeTarget(), partySize: 4 },
      version: 1,
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      readonly target: {
        readonly version: number;
        readonly state: string;
        readonly target: { readonly id: string; readonly partySize: number };
      };
    };
    expect(payload.target.version).toBe(2);
    expect(payload.target.state).toBe("DRAFT");
    expect(payload.target.target.id).toBe("target-1");
    expect(payload.target.target.partySize).toBe(4);
  });

  it("clears a stale pause reason when a paused task is edited or re-armed", async () => {
    const harness = await startHarness();
    await jsonPost(harness, "/api/targets", { target: makeTarget(), arm: true });
    const paused = await jsonPost(harness, "/api/targets/target-1/state", {
      action: "pause",
      version: 1,
    });
    expect(paused.status).toBe(200);

    const edited = await jsonPut(harness, "/api/targets/target-1", {
      target: { ...makeTarget(), partySize: 6 },
      version: 2,
    });
    expect(edited.status).toBe(200);
    const editedPayload = (await edited.json()) as {
      readonly target: { readonly state: string; readonly pauseReason?: string };
    };
    expect(editedPayload.target.state).toBe("PAUSED");
    expect(editedPayload.target.pauseReason).toBeUndefined();

    const rearmed = await jsonPost(harness, "/api/targets/target-1/state", {
      action: "arm",
      version: 3,
    });
    expect(rearmed.status).toBe(200);
    const rearmedPayload = (await rearmed.json()) as {
      readonly target: { readonly state: string; readonly pauseReason?: string };
    };
    expect(rearmedPayload.target.state).toBe("ARMED");
    expect(rearmedPayload.target.pauseReason).toBeUndefined();
  });

  it("refuses to edit a task that is already booking or booked", async () => {
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
    const response = await jsonPut(harness, "/api/targets/target-1", {
      target: { ...makeTarget(), partySize: 4 },
      version: 1,
    });
    expect(response.status).toBe(409);
    const payload = (await response.json()) as {
      readonly error: { readonly reason: string };
    };
    expect(payload.error.reason).toBe("NOT_EDITABLE");
  });

  it("rejects an edit at a stale version", async () => {
    const harness = await startHarness();
    await jsonPost(harness, "/api/targets", { target: makeTarget() });
    const response = await jsonPut(harness, "/api/targets/target-1", {
      target: { ...makeTarget(), partySize: 4 },
      version: 0,
    });
    expect(response.status).toBe(409);
    const payload = (await response.json()) as {
      readonly error: { readonly reason: string };
    };
    expect(payload.error.reason).toBe("VERSION_CONFLICT");
  });

  // The probe is a read: it reports what the restaurant offers so the console
  // can offer real times and real dining areas instead of free-text guesses.
  it("probes real availability and dining areas for a date", async () => {
    const harness = await startHarness({
      findSlots: async () => [
        makeSlot({
          id: "slot-a",
          localTime: "18:30",
          diningArea: { category: "dining-room", label: "Dining Room", providerOrder: 0 },
        }),
        makeSlot({
          id: "slot-b",
          localTime: "19:00",
          diningArea: { category: "terrace", label: "Sky Terrace", providerOrder: 1 },
        }),
        makeSlot({
          id: "slot-c",
          localTime: "18:30",
          diningArea: { category: "bar", label: "Bar", providerOrder: 2 },
        }),
      ],
    });

    const response = await jsonPost(harness, "/api/probe", probeBody());
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      readonly probe: {
        readonly times: readonly string[];
        readonly diningAreas: readonly { readonly label: string }[];
        readonly options: readonly {
          readonly time: string;
          readonly label: string;
        }[];
      };
    };
    expect(payload.probe.times).toEqual(["18:30", "19:00"]);
    expect(payload.probe.diningAreas.map((area) => area.label)).toEqual([
      "Dining Room",
      "Sky Terrace",
      "Bar",
    ]);
    expect(payload.probe.options.map((option) => `${option.time} ${option.label}`)).toEqual([
      "18:30 Bar",
      "18:30 Dining Room",
      "19:00 Sky Terrace",
    ]);

    const probeTarget = harness.findSlots.mock.calls[0]?.[0] as BookingTarget;
    expect(probeTarget.diningAreaPolicy).toEqual({
      mode: "any",
      selection: "provider-order",
    });
    expect(probeTarget.bookingPolicy.autoBookAuthorized).toBe(false);
    expect(probeTarget.dateRange).toEqual({
      startDate: "2026-09-01",
      endDate: "2026-09-01",
    });
    expect(probeTarget.timeWindow).toEqual({
      earliest: "17:00",
      latest: "21:00",
      preferred: "19:00",
    });
  });

  it("rejects an invalid availability probe", async () => {
    const harness = await startHarness();
    const response = await jsonPost(harness, "/api/probe", probeBody({ partySize: 0 }));
    expect(response.status).toBe(400);
    expect(harness.findSlots).not.toHaveBeenCalled();
  });

  it("previews booking terms and allows an authorized booking", async () => {
    const harness = await startHarness();
    const response = await jsonPost(harness, "/api/preview", {
      target: makeTarget(),
      time: "19:00",
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      readonly preview: {
        readonly allowed: boolean;
        readonly reasons: readonly string[];
        readonly time: string;
        readonly diningArea?: { readonly label: string };
        readonly terms: { readonly prepaid: { readonly status: string } };
      };
    };
    expect(payload.preview.allowed).toBe(true);
    expect(payload.preview.reasons).toEqual([]);
    expect(payload.preview.time).toBe("19:00");
    expect(payload.preview.diningArea?.label).toBe("Dining Room");
    expect(payload.preview.terms.prepaid.status).toBe("not-required");
  });

  it("previews the exact policy reasons that would stop a booking", async () => {
    const harness = await startHarness({
      getBookingPreview: async () =>
        makePreview({ prepaid: { status: "required-known", amountCents: 50_000 } }),
    });
    const response = await jsonPost(harness, "/api/preview", {
      target: makeTarget(),
      time: "19:00",
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      readonly preview: {
        readonly allowed: boolean;
        readonly reasons: readonly string[];
      };
    };
    expect(payload.preview.allowed).toBe(false);
    expect(payload.preview.reasons).toContain("PREPAID_AMOUNT_EXCEEDS_AUTHORIZATION");
  });

  it("reports an unauthorized task as a preview rejection", async () => {
    const harness = await startHarness();
    const target = makeTarget();
    const response = await jsonPost(harness, "/api/preview", {
      target: {
        ...target,
        bookingPolicy: { ...target.bookingPolicy, autoBookAuthorized: false },
      },
      time: "19:00",
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      readonly preview: { readonly allowed: boolean; readonly reasons: readonly string[] };
    };
    expect(payload.preview.allowed).toBe(false);
    expect(payload.preview.reasons).toContain("AUTO_BOOK_NOT_AUTHORIZED");
  });

  it("reports a missing slot as a conflict during preview", async () => {
    const harness = await startHarness({ findSlots: async () => [] });
    const response = await jsonPost(harness, "/api/preview", {
      target: makeTarget(),
      time: "19:00",
    });
    expect(response.status).toBe(409);
    const payload = (await response.json()) as {
      readonly error: { readonly reason: string };
    };
    expect(payload.error.reason).toBe("NO_MATCHING_SLOT");
    expect(harness.getBookingPreview).not.toHaveBeenCalled();
  });

  // The server rejects non-JSON mutations, so the console must set the header on
  // every mutation, including bodyless ones such as DELETE.
  it("serves a console that sends JSON on bodyless mutations", async () => {
    const harness = await startHarness();
    const html = await (await fetch(`${harness.address.url}/`)).text();
    expect(html).toContain('(init.method || "GET") !== "GET"');
    expect(html).toContain('init.headers = { "content-type": "application/json" };');
  });

  // The console's JavaScript is served as one opaque template, so assert the
  // features it must wire up rather than rendering the page.
  it("serves a console with typeahead, availability, preview, and editing", async () => {
    const harness = await startHarness();
    const html = await (await fetch(`${harness.address.url}/`)).text();
    expect(html).toContain('id="search-suggestions"');
    expect(html).toContain("scheduleTypeahead");
    expect(html).toContain('api("/api/probe"');
    expect(html).toContain('api("/api/preview"');
    expect(html).toContain('method: "PUT"');
    expect(html).toContain("Check availability");
    expect(html).toContain("Preview terms");
    expect(html).toContain("Edit");
    // No template-literal syntax: the file is a String.raw template.
    expect(html).not.toContain("${");
  });

  // The console reads state out of the DOM by id, and nothing else checks that
  // those ids exist in the markup, so a renamed or dropped element silently
  // breaks a whole control.
  it("serves a console whose every byId target exists in the markup", async () => {
    const harness = await startHarness();
    const html = await (await fetch(`${harness.address.url}/`)).text();
    const referenced = new Set(
      [...html.matchAll(/byId\("([^"]+)"\)/gu)].map((match) => match[1] ?? ""),
    );
    const declared = new Set(
      [...html.matchAll(/id="([^"]+)"/gu)].map((match) => match[1] ?? ""),
    );
    expect(referenced.size).toBeGreaterThan(20);
    expect([...referenced].filter((id) => !declared.has(id))).toEqual([]);
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
