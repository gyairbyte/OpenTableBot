import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AvailabilityRunDetail,
  ObservedAvailabilitySlot,
} from "../src/domain/availability-detail.js";
import type { AuthenticationStatus } from "../src/opentable/adapter.js";
import type { OpenTableBridgeClientPort } from "../src/opentable/bridge/read-adapter.js";
import { BrowserBridgeOpenTableReadAdapter } from "../src/opentable/bridge/read-adapter.js";
import type {
  FindSlotsResult,
  GetBookingPreviewResult,
  ListDiningAreasResult,
  SearchRestaurantsResult,
} from "../src/opentable/bridge/protocol.js";
import { TargetState } from "../src/domain/target-state.js";
import { FileTargetStore } from "../src/storage/file-target-store.js";
import { UiServer, type UiRuntimeStatus } from "../src/ui/server.js";
import { makePreview, makeSlot, makeTarget } from "./fixtures.js";

async function tempDirectory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "otb-detail-"));
}

/** Availability with one out-of-window time (20:30) around the 19:00 request. */
function availabilityResponse(): FindSlotsResult {
  return {
    protocolVersion: 1,
    id: "response-id",
    type: "FIND_SLOTS_RESULT",
    request: {
      restaurantId: "restaurant-123",
      date: "2026-09-01",
      time: "19:00",
      partySize: 2,
      databaseRegion: "NA",
    },
    data: {
      availability: [
        {
          restaurantId: "restaurant-123",
          availabilityDays: [
            {
              dayOffset: 0,
              slots: [
                {
                  isAvailable: true,
                  timeOffsetMinutes: -30,
                  type: "Standard",
                  attributes: ["default"],
                  previewReference: "00000000-0000-4000-8000-000000000001",
                },
                {
                  isAvailable: true,
                  timeOffsetMinutes: 0,
                  type: "Standard",
                  attributes: ["default"],
                  previewReference: "00000000-0000-4000-8000-000000000002",
                },
                {
                  isAvailable: true,
                  timeOffsetMinutes: 90,
                  type: "Standard",
                  attributes: ["default"],
                  previewReference: "00000000-0000-4000-8000-000000000003",
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

class DetailBridgeClient implements OpenTableBridgeClientPort {
  async connect(): Promise<void> {}
  close(): void {}
  async authenticationStatus(): Promise<AuthenticationStatus> {
    return { authenticated: true };
  }
  async findSlots(): Promise<FindSlotsResult> {
    return availabilityResponse();
  }
  async listDiningAreas(): Promise<ListDiningAreasResult> {
    const slot = makeSlot();
    return {
      protocolVersion: 1,
      id: "dining-areas-response",
      type: "LIST_DINING_AREAS_RESULT",
      request: {
        baseSlotId: slot.id,
        previewReference: slot.previewReference!,
        restaurantId: slot.restaurantId,
        date: slot.localDate,
        time: slot.localTime,
        partySize: slot.partySize,
        seatingType: slot.seatingType,
        reservationKind: slot.reservationKind,
      },
      candidates: [
        {
          previewReference: "00000000-0000-4000-8000-000000000004",
          diningArea: slot.diningArea!,
        },
      ],
    };
  }
  async searchRestaurants(): Promise<SearchRestaurantsResult> {
    throw new Error("not used in this test");
  }
  async getBookingPreview(): Promise<GetBookingPreviewResult> {
    throw new Error("not used in this test");
  }
}

function observed(
  overrides: Partial<ObservedAvailabilitySlot> = {},
): ObservedAvailabilitySlot {
  return {
    localDate: "2026-09-01",
    localTime: "19:00",
    seatingType: "standard",
    reservationKind: "standard",
    withinWindow: true,
    rejectionReasons: [],
    diningAreas: [],
    ...overrides,
  };
}

function runDetail(): AvailabilityRunDetail {
  return {
    preferredTime: "19:00",
    earliest: "18:00",
    latest: "20:00",
    matched: false,
    capturedAt: "2026-10-10T14:00:00.000Z",
    attempts: [
      {
        startedAt: "2026-10-10T14:00:00.000Z",
        durationMs: 258,
        acceptableSlots: 0,
        preferredSlots: 0,
        observedSlots: [
          observed({ localTime: "20:30", withinWindow: false }),
          observed({
            localTime: "20:45",
            withinWindow: false,
            rejectionReasons: ["TIME_OUTSIDE_WINDOW"],
          }),
        ],
      },
    ],
  };
}

describe("detailed availability", () => {
  it("keeps out-of-window times in the observation while findSlots drops them", async () => {
    const adapter = new BrowserBridgeOpenTableReadAdapter(new DetailBridgeClient());

    const detail = await adapter.findSlotsDetailed(makeTarget());
    expect(detail.acceptableSlots.map((slot) => slot.localTime).sort()).toEqual([
      "18:30",
      "19:00",
    ]);
    expect(detail.observedSlots).toHaveLength(3);

    const inWindowPreferred = detail.observedSlots.find(
      (slot) => slot.localTime === "19:00",
    );
    expect(inWindowPreferred).toMatchObject({
      withinWindow: true,
      rejectionReasons: [],
      diningAreas: ["Dining Room"],
    });
    const outOfWindow = detail.observedSlots.find(
      (slot) => slot.localTime === "20:30",
    );
    expect(outOfWindow).toMatchObject({
      withinWindow: false,
      rejectionReasons: ["TIME_OUTSIDE_WINDOW"],
      diningAreas: [],
    });

    const plain = await adapter.findSlots(makeTarget());
    expect(plain).toEqual(detail.acceptableSlots);
  });

  it("persists the run detail in the state file and clears it on the next save", async () => {
    const store = new FileTargetStore({
      directory: await tempDirectory(),
      now: () => new Date("2026-10-10T14:00:00.000Z"),
    });
    await store.save(
      {
        target: makeTarget(),
        state: TargetState.PAUSED,
        version: 0,
        createdAt: "2026-10-10T13:00:00.000Z",
        updatedAt: "2026-10-10T13:00:00.000Z",
        pauseReason: "No slot at the preferred time 19:00",
        availabilityDetail: runDetail(),
      },
      0,
    );

    const loaded = await store.get("target-1");
    if (loaded === undefined) throw new Error("The seeded record disappeared");
    expect(loaded.availabilityDetail).toEqual(runDetail());

    await store.save(
      {
        ...loaded,
        state: TargetState.ARMED,
        availabilityDetail: undefined,
      },
      loaded.version,
    );
    expect((await store.get("target-1"))?.availabilityDetail).toBeUndefined();
  });

  it("still loads state files written before the detail field existed", async () => {
    const directory = await tempDirectory();
    await writeFile(
      path.join(directory, "targets.json"),
      `${JSON.stringify(
        {
          version: 1,
          records: [
            {
              version: 17,
              createdAt: "2026-10-10T02:01:56.335Z",
              updatedAt: "2026-10-10T14:00:00.276Z",
              state: "PAUSED",
              pauseReason:
                "No slot at the preferred time 12:00; 0 slot(s) were returned",
              target: makeTarget(),
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const store = new FileTargetStore({ directory });
    const record = await store.get("target-1");
    expect(record?.state).toBe(TargetState.PAUSED);
    expect(record?.availabilityDetail).toBeUndefined();
  });

  it("serves the run detail to the console unchanged", async () => {
    const store = new FileTargetStore({
      directory: await tempDirectory(),
      now: () => new Date("2026-10-10T14:00:00.000Z"),
    });
    await store.save(
      {
        target: makeTarget(),
        state: TargetState.PAUSED,
        version: 0,
        createdAt: "2026-10-10T13:00:00.000Z",
        updatedAt: "2026-10-10T13:00:00.000Z",
        pauseReason: "No slot at the preferred time 19:00",
        availabilityDetail: runDetail(),
      },
      0,
    );
    const server = new UiServer({
      store,
      adapter: {
        searchRestaurants: async () => ({ results: [] }),
        findSlots: async () => [],
        getBookingPreview: async () => makePreview(),
      },
      status: async (): Promise<UiRuntimeStatus> => ({
        bridgeReachable: true,
        authenticated: true,
        mode: "execute",
        stateDirectory: "test-state",
      }),
      port: 0,
    });
    const address = await server.start();

    try {
      const targetsPayload = (await (
        await fetch(`${address.url}/api/targets`)
      ).json()) as { targets: readonly { availabilityDetail?: unknown }[] };
      expect(targetsPayload.targets[0]?.availabilityDetail).toEqual(runDetail());

      const html = await (await fetch(address.url)).text();
      expect(html).toContain("availabilityDetailWidget");
      expect(html).toContain("Availability detail");
    } finally {
      await server.close();
    }
  });
});
