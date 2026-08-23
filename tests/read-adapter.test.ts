import { describe, expect, it } from "vitest";
import type { AuthenticationStatus, OpenTableReadAdapter } from "../src/opentable/adapter.js";
import { AdapterFailureCategory, type OpenTableAdapterError } from "../src/opentable/errors.js";
import type { OpenTableBridgeClientPort } from "../src/opentable/bridge/read-adapter.js";
import { BrowserBridgeOpenTableReadAdapter } from "../src/opentable/bridge/read-adapter.js";
import type { FindSlotsResult } from "../src/opentable/bridge/protocol.js";
import { makeTarget } from "./fixtures.js";
import { makeAvailabilityObservation } from "./opentable-fixtures.js";

function availabilityData(): FindSlotsResult["data"] {
  const payload = makeAvailabilityObservation().payload as {
    readonly data: FindSlotsResult["data"];
  };
  return payload.data;
}

class FakeBridgeClient implements OpenTableBridgeClientPort {
  constructor(
    private readonly response: FindSlotsResult = {
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
      data: availabilityData(),
    },
  ) {}

  async connect(): Promise<void> {}
  close(): void {}
  async authenticationStatus(): Promise<AuthenticationStatus> {
    return { authenticated: true };
  }
  async findSlots(): Promise<FindSlotsResult> {
    return this.response;
  }
}

class UnauthenticatedBridgeClient extends FakeBridgeClient {
  override async authenticationStatus(): Promise<{ readonly authenticated: false; readonly reason: "required" }> {
    return { authenticated: false, reason: "required" };
  }
}

describe("BrowserBridgeOpenTableReadAdapter", () => {
  it("implements only the read contract and returns verified normalized slots", async () => {
    const adapter: OpenTableReadAdapter = new BrowserBridgeOpenTableReadAdapter(new FakeBridgeClient());
    const slots = await adapter.findSlots(makeTarget());
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      restaurantId: "restaurant-123",
      localDate: "2026-09-01",
      partySize: 2,
    });
    expect("prepareBooking" in adapter).toBe(false);
    expect("book" in adapter).toBe(false);
  });

  it("does not return slots when response invariants fail", async () => {
    const adapter = new BrowserBridgeOpenTableReadAdapter(
      new FakeBridgeClient({
        protocolVersion: 1,
        id: "response-id",
        type: "FIND_SLOTS_RESULT",
        request: {
          restaurantId: "restaurant-123",
          date: "2026-09-01",
          time: "19:00",
          partySize: 5,
          databaseRegion: "NA",
        },
        data: availabilityData(),
      }),
    );
    await expect(adapter.findSlots(makeTarget())).rejects.toMatchObject({
      category: AdapterFailureCategory.INVARIANT_MISMATCH,
    } satisfies Partial<OpenTableAdapterError>);
  });

  it("fails closed when Chrome reports an unauthenticated page", async () => {
    const adapter = new BrowserBridgeOpenTableReadAdapter(new UnauthenticatedBridgeClient());
    await expect(adapter.findSlots(makeTarget())).rejects.toMatchObject({
      category: AdapterFailureCategory.AUTHENTICATION_REQUIRED,
    });
  });
});
