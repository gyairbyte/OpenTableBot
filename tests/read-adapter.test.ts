import { describe, expect, it } from "vitest";
import type { AuthenticationStatus, OpenTableReadAdapter } from "../src/opentable/adapter.js";
import { AdapterFailureCategory, type OpenTableAdapterError } from "../src/opentable/errors.js";
import type { OpenTableBridgeClientPort } from "../src/opentable/bridge/read-adapter.js";
import { BrowserBridgeOpenTableReadAdapter } from "../src/opentable/bridge/read-adapter.js";
import { BridgeClientError } from "../src/opentable/bridge/client.js";
import {
  AVAILABILITY_OPERATION_NOT_OBSERVED_MESSAGE,
  AVAILABILITY_PROVIDER_ERRORS_MESSAGE,
} from "../src/opentable/bridge/page-errors.js";
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
      `${AVAILABILITY_PROVIDER_ERRORS_MESSAGE}: Internal server error`,
      AdapterFailureCategory.TRANSIENT_TRANSPORT,
    ],
    [
      "PAGE_OPERATION_UNAVAILABLE",
      "RestaurantsAvailability HTTP 504; replay diff: restaurantIds [number]->[number]",
      AdapterFailureCategory.TRANSIENT_TRANSPORT,
    ],
    [
      "PAGE_OPERATION_UNAVAILABLE",
      "RestaurantsAvailability HTTP 503; provider body: Service Unavailable",
      AdapterFailureCategory.TRANSIENT_TRANSPORT,
    ],
    [
      "PAGE_OPERATION_UNAVAILABLE",
      "RestaurantsAvailability HTTP 403; replay diff: restaurantIds [number]->[number]",
      AdapterFailureCategory.UNEXPECTED_RESPONSE,
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

  it.each([
    "BOOKING_PREVIEW_DINING_AREA_UNKNOWN: Provider response contained no matching dining area",
    "BOOKING_PREVIEW_DINING_AREA_CONFLICT: Provider identity had conflicting display labels",
  ])("fails closed with the reason when every slot's dining areas cannot be established (%s)", async (message) => {
    class UnestablishedAreaClient extends FakeBridgeClient {
      override async listDiningAreas(): Promise<ListDiningAreasResult> {
        throw new BridgeClientError("PAGE_OPERATION_UNAVAILABLE", message);
      }
    }
    const diagnostics: string[] = [];
    const adapter = new BrowserBridgeOpenTableReadAdapter(new UnestablishedAreaClient(), {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await expect(adapter.findSlotsDetailed(makeTarget())).rejects.toMatchObject({
      category: AdapterFailureCategory.UNEXPECTED_RESPONSE,
      message: expect.stringContaining(message),
    });
    expect(diagnostics.some((diagnostic) => diagnostic.includes("skipped") && diagnostic.includes(message))).toBe(true);
  });

  it("skips only the slot whose dining areas cannot be established and records why", async () => {
    const message = "BOOKING_PREVIEW_DINING_AREA_UNKNOWN: Provider response contained no matching dining area";
    class FirstSlotUnestablishedClient extends FakeBridgeClient {
      private calls = 0;
      override async listDiningAreas(): Promise<ListDiningAreasResult> {
        this.calls += 1;
        if (this.calls === 1) throw new BridgeClientError("PAGE_OPERATION_UNAVAILABLE", message);
        return super.listDiningAreas();
      }
    }
    const data = structuredClone(availabilityData()) as {
      availability: { availabilityDays: { slots: Record<string, unknown>[] }[] }[];
    };
    const slots = data.availability[0]!.availabilityDays[0]!.slots;
    slots.push({ ...slots[0]!, timeOffsetMinutes: 0, previewReference: "00000000-0000-4000-8000-000000000003" });
    const adapter = new BrowserBridgeOpenTableReadAdapter(new FirstSlotUnestablishedClient({
      protocolVersion: 1,
      id: "response-id",
      type: "FIND_SLOTS_RESULT",
      request: { restaurantId: "restaurant-123", date: "2026-09-01", time: "19:00", partySize: 2, databaseRegion: "NA" },
      data: data as unknown as FindSlotsResult["data"],
    }));
    const detailed = await adapter.findSlotsDetailed(makeTarget());
    const skipped = detailed.observedSlots.filter((slot) => slot.diningAreaIssue !== undefined);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.diningAreaIssue).toBe(message);
    expect(skipped[0]?.diningAreas).toEqual([]);
    expect(detailed.acceptableSlots.length).toBeGreaterThan(0);
  });

  it("still fails the scan on other dining-area discovery errors", async () => {
    class FailingDiscoveryClient extends FakeBridgeClient {
      override async listDiningAreas(): Promise<ListDiningAreasResult> {
        throw new BridgeClientError("PAGE_OPERATION_UNAVAILABLE", "Booking details returned HTTP 403");
      }
    }
    const adapter = new BrowserBridgeOpenTableReadAdapter(new FailingDiscoveryClient());
    await expect(adapter.findSlots(makeTarget())).rejects.toMatchObject({
      category: AdapterFailureCategory.UNEXPECTED_RESPONSE,
    });
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
