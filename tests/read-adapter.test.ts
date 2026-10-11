import { describe, expect, it } from "vitest";
import type { AuthenticationStatus, OpenTableReadAdapter } from "../src/opentable/adapter.js";
import { AdapterFailureCategory, type OpenTableAdapterError } from "../src/opentable/errors.js";
import type { OpenTableBridgeClientPort } from "../src/opentable/bridge/read-adapter.js";
import { BrowserBridgeOpenTableReadAdapter } from "../src/opentable/bridge/read-adapter.js";
import { BridgeClientError } from "../src/opentable/bridge/client.js";
import { AVAILABILITY_OPERATION_NOT_OBSERVED_MESSAGE } from "../src/opentable/bridge/page-errors.js";
import type {
  FindSlotsResult,
  GetBookingPreviewResult,
  ListDiningAreasResult,
  SearchRestaurantsResult,
} from "../src/opentable/bridge/protocol.js";
import { makeSlot, makeTarget } from "./fixtures.js";
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
      candidates: [{
        previewReference: "00000000-0000-4000-8000-000000000002",
        diningArea: slot.diningArea!,
      }],
    };
  }
  async searchRestaurants(): Promise<SearchRestaurantsResult> {
    return {
      protocolVersion: 1,
      id: "search-response",
      type: "SEARCH_RESTAURANTS_RESULT",
      request: { term: "sushi" },
      data: {
        results: [
          {
            restaurantId: "70204",
            name: "Catch New York",
            profileUrl: "https://www.opentable.com/r/catch-new-york",
            bookable: true,
          },
        ],
      },
    };
  }
  async getBookingPreview(): Promise<GetBookingPreviewResult> {
    const slot = makeSlot();
    return {
      protocolVersion: 1,
      id: "preview-response",
      type: "GET_BOOKING_PREVIEW_RESULT",
      request: {
        slotId: slot.id,
        previewReference: slot.previewReference!,
        restaurantId: slot.restaurantId,
        date: slot.localDate,
        time: slot.localTime,
        partySize: slot.partySize,
        seatingType: slot.seatingType,
        diningArea: slot.diningArea!,
        reservationKind: { kind: "standard" },
      },
      data: {
        restaurantId: slot.restaurantId,
        reservationDateTime: `${slot.localDate}T${slot.localTime}`,
        partySize: slot.partySize,
        seatingType: "default",
        reservationType: "Standard",
        creditCardRequired: false,
        currencyCode: "USD",
        diningArea: slot.diningArea!,
      },
    };
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

  it.each([
    ["PAGE_NOT_READY", "No eligible OpenTable page is ready", AdapterFailureCategory.BROWSER_NOT_READY],
    [
      "PAGE_OPERATION_UNAVAILABLE",
      AVAILABILITY_OPERATION_NOT_OBSERVED_MESSAGE,
      AdapterFailureCategory.BROWSER_NOT_READY,
    ],
    [
      "PAGE_OPERATION_UNAVAILABLE",
      "Availability request failed validation",
      AdapterFailureCategory.UNEXPECTED_RESPONSE,
    ],
  ] as const)("maps %s (%s) to %s", async (code, message, category) => {
    class FailingClient extends FakeBridgeClient {
      override async findSlots(): Promise<FindSlotsResult> {
        throw new BridgeClientError(code, message);
      }
    }
    const adapter = new BrowserBridgeOpenTableReadAdapter(new FailingClient());
    await expect(adapter.findSlots(makeTarget())).rejects.toMatchObject({ category });
  });

  it("retrieves a read-only preview without implementing prepare or book", async () => {
    const adapter = new BrowserBridgeOpenTableReadAdapter(new FakeBridgeClient());
    const preview = await adapter.getBookingPreview(makeTarget(), makeSlot());
    expect(preview).toMatchObject({
      slotId: "slot-1",
      reservationKind: { kind: "standard" },
      paymentRequirement: "not-required",
    });
    expect("prepareBooking" in adapter).toBe(false);
    expect("book" in adapter).toBe(false);
  });
});
