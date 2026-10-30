import { describe, expect, it } from "vitest";
import {
  sanitizeAvailabilityResult,
  sanitizeBookingPreviewResult,
  sanitizeSearchResults,
} from "../extension/src/content.js";
import type { DiningAreaOption } from "../src/domain/dining-area.js";

const standardPreviewRequest = {
  slotId: "slot-seating-regression",
  previewReference: "00000000-0000-4000-8000-000000000003",
  restaurantId: "994474",
  date: "2026-08-29",
  time: "19:00",
  partySize: 2,
  seatingType: "standard" as const,
  diningArea: {
    category: "dining-room" as const,
    label: "Dining Room",
    providerOrder: 0,
  },
  reservationKind: { kind: "standard" as const },
};

function exactPreviewResult(
  detailsState: Record<string, unknown>,
  providerId: number,
  option: DiningAreaOption = standardPreviewRequest.diningArea,
  tableCategory?: string,
): Record<string, unknown> {
  return {
    detailsState,
    selectedDiningArea: {
      providerId,
      option,
      ...(tableCategory === undefined ? {} : { tableCategory }),
    },
  };
}

function bookingDetailsWithDiningAreas(
  diningAreasBySeating: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return {
    restaurant: { restaurantId: 994474, name: "Don Angie" },
    reservationDateTime: "2026-08-29T19:00",
    partySize: 2,
    timeSlot: {
      reservationType: "Standard",
      creditCardRequired: false,
      diningAreasBySeating,
    },
  };
}

describe("extension availability sanitizer", () => {
  it("projects only approved fields before data can leave Chrome", () => {
    const sanitized = sanitizeAvailabilityResult({
      availability: [
        {
          restaurantId: 123,
          restaurantName: "private extra field",
          availabilityDays: [
            {
              dayOffset: 0,
              slots: [
                {
                  isAvailable: true,
                  timeOffsetMinutes: 15,
                  attributes: ["Standard"],
                  type: "default",
                  dateTime: "2026-09-01T19:15:00-04:00",
                  slotHash: "must-not-cross-boundary",
                  availabilityToken: "must-not-cross-boundary",
                },
              ],
            },
          ],
        },
      ],
      account: { email: "must-not-cross-boundary@example.test" },
    });
    expect(sanitized).toEqual({
      availability: [
        {
          restaurantId: 123,
          availabilityDays: [
            {
              dayOffset: 0,
              slots: [
                {
                  isAvailable: true,
                  timeOffsetMinutes: 15,
                  attributes: ["Standard"],
                  type: "default",
                  dateTime: "2026-09-01T19:15:00-04:00",
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("returns only the requested restaurant from a multi-restaurant page response", () => {
    const sanitized = sanitizeAvailabilityResult(
      {
        availability: [
          { restaurantId: "other", availabilityDays: [] },
          { restaurantId: "994474", availabilityDays: [] },
        ],
      },
      "994474",
    );
    expect(sanitized.availability).toEqual([
      { restaurantId: "994474", availabilityDays: [] },
    ]);
  });

  it("projects booking details without browser, account, or payment secrets", () => {
    const sanitized = sanitizeBookingPreviewResult(
      exactPreviewResult({
        restaurant: {
          restaurantId: 994474,
          name: "Don Angie",
          currencyCode: "USD",
          privateProviderConfig: "must-not-cross",
        },
        reservationDateTime: "2026-08-29T19:00",
        partySize: 2,
        timeSlot: {
          reservationType: "Standard",
          creditCardRequired: true,
          creditCardPolicyType: "Hold",
          slotHash: "must-not-cross",
          slotAvailabilityToken: "must-not-cross",
          csrfToken: "must-not-cross",
          diningAreasBySeating: [
            { diningAreaId: 1, tableCategory: "default", paymentToken: "secret" },
          ],
        },
        messages: {
          cancellationPolicyMessage: {
            cancellationMessage: { message: "Cancellations incur a $25 fee." },
          },
        },
        wallet: {
          savedCards: [
            {
              cardId: "must-not-cross",
              last4: "4242",
              paymentToken: "must-not-cross",
            },
          ],
        },
        account: { email: "must-not-cross@example.test", sessionId: "secret" },
        headers: { Cookie: "secret", Authorization: "secret", "Set-Cookie": "secret" },
      }, 1),
      {
        slotId: "slot-1",
        previewReference: "00000000-0000-4000-8000-000000000001",
        restaurantId: "994474",
        date: "2026-08-29",
        time: "19:00",
        partySize: 2,
        seatingType: "standard",
        diningArea: standardPreviewRequest.diningArea,
        reservationKind: { kind: "standard" },
      },
    );
    expect(sanitized).toEqual({
      restaurantId: 994474,
      restaurantName: "Don Angie",
      reservationDateTime: "2026-08-29T19:00",
      partySize: 2,
      seatingType: "default",
      reservationType: "Standard",
      creditCardRequired: true,
      creditCardPolicyType: "Hold",
      currencyCode: "USD",
      cancellationMessage: "Cancellations incur a $25 fee.",
      diningArea: standardPreviewRequest.diningArea,
    });
    expect(JSON.stringify(sanitized)).not.toMatch(
      /cookie|authorization|csrf|token|last4|cardId|email|sessionId/iu,
    );
  });

  it("normalizes the structured reservation datetime used by booking-details SSR", () => {
    const sanitized = sanitizeBookingPreviewResult(
      exactPreviewResult({
        restaurant: { restaurantId: 1272781, name: "State of Confusion" },
        reservationDateTime: {
          reservationDate: "2026-08-24",
          reservationTime: "19:00",
        },
        partySize: 2,
        timeSlot: {
          reservationType: "Standard",
          creditCardRequired: false,
          diningAreasBySeating: [{ diningAreaId: 48750, tableCategory: "default" }],
        },
      }, 48750),
      {
        slotId: "slot-live-shape",
        previewReference: "00000000-0000-4000-8000-000000000002",
        restaurantId: "1272781",
        date: "2026-08-24",
        time: "19:00",
        partySize: 2,
        seatingType: "standard",
        diningArea: standardPreviewRequest.diningArea,
        reservationKind: { kind: "standard" },
      },
    );

    expect(sanitized.reservationDateTime).toBe("2026-08-24T19:00");
  });

  it("returns the actual provider dining area when requested seating exists", () => {
    const sanitized = sanitizeBookingPreviewResult(
      exactPreviewResult(bookingDetailsWithDiningAreas([
        { diningAreaId: 11, tableCategory: "default" },
      ]), 11),
      standardPreviewRequest,
    );

    expect(sanitized).toMatchObject({
      seatingType: "default",
      diningArea: standardPreviewRequest.diningArea,
    });
  });

  it("returns a requested seating area when it is the second provider item", () => {
    const sanitized = sanitizeBookingPreviewResult(
      exactPreviewResult(bookingDetailsWithDiningAreas([
        { diningAreaId: 11, tableCategory: "default" },
        { diningAreaId: 22, tableCategory: "outdoor" },
      ]), 22, { category: "outdoor", label: "Patio", providerOrder: 1 }),
      {
        ...standardPreviewRequest,
        seatingType: "outdoor",
        diningArea: { category: "outdoor", label: "Patio", providerOrder: 1 },
      },
    );

    expect(sanitized).toMatchObject({
      seatingType: "outdoor",
      diningArea: { category: "outdoor", label: "Patio", providerOrder: 1 },
    });
  });

  it("fails with a structured mismatch when requested seating is absent", () => {
    expect(() =>
      sanitizeBookingPreviewResult(
        exactPreviewResult(bookingDetailsWithDiningAreas([
          { diningAreaId: 22, tableCategory: "outdoor" },
        ]), 11),
        standardPreviewRequest,
      ),
    ).toThrow(/BOOKING_PREVIEW_DINING_AREA_MISMATCH/u);
  });

  it("does not fall back to the first unrelated dining area", () => {
    expect(() =>
      sanitizeBookingPreviewResult(
        exactPreviewResult(bookingDetailsWithDiningAreas([
          { diningAreaId: 11, tableCategory: "default" },
        ]), 11),
        {
          ...standardPreviewRequest,
          seatingType: "outdoor",
          diningArea: { category: "outdoor", label: "Patio", providerOrder: 0 },
        },
      ),
    ).toThrow(/BOOKING_PREVIEW_DINING_AREA_MISMATCH/u);
  });

  it("selects one exact provider identity when unrelated areas coexist", () => {
    const sanitized = sanitizeBookingPreviewResult(
      exactPreviewResult(bookingDetailsWithDiningAreas([
        { diningAreaId: 22, tableCategory: "outdoor" },
        { diningAreaId: 33, tableCategory: "bar" },
      ]), 22),
      standardPreviewRequest,
    );
    expect(sanitized.seatingType).toBe("outdoor");
  });

  it("fails closed when the provider supplies no usable seating information", () => {
    expect(() =>
      sanitizeBookingPreviewResult(
        exactPreviewResult(bookingDetailsWithDiningAreas([]), 1),
        standardPreviewRequest,
      ),
    ).toThrow(/BOOKING_PREVIEW_SEATING_UNKNOWN/u);
  });

  it("returns the provider seating label instead of copying the requested value", () => {
    const sanitized = sanitizeBookingPreviewResult(
      exactPreviewResult(bookingDetailsWithDiningAreas([
        { diningAreaId: 44, tableCategory: "highTop" },
      ]), 44, { category: "high-top", label: "High Top", providerOrder: 0 }),
      {
        ...standardPreviewRequest,
        seatingType: "high-top",
        diningArea: { category: "high-top", label: "High Top", providerOrder: 0 },
      },
    );

    expect(sanitized.seatingType).toBe("highTop");
    expect(sanitized.seatingType).not.toBe("high-top");
  });

  // A restaurant can list Standard and Outdoor under one dining area id (both
  // shown under "Other"). The category the preview was bound to picks the entry.
  describe("one dining area offering several table categories", () => {
    const sharedArea = [
      { diningAreaId: 11, tableCategory: "default" },
      { diningAreaId: 11, tableCategory: "outdoor" },
    ];
    const other: DiningAreaOption = { category: "other", label: "Other", providerOrder: 0 };

    it("selects the standard entry for a standard-bound preview", () => {
      const sanitized = sanitizeBookingPreviewResult(
        exactPreviewResult(bookingDetailsWithDiningAreas(sharedArea), 11, other, "default"),
        { ...standardPreviewRequest, diningArea: other },
      );
      expect(sanitized.seatingType).toBe("default");
    });

    it("selects the outdoor entry for an outdoor-bound preview", () => {
      const sanitized = sanitizeBookingPreviewResult(
        exactPreviewResult(bookingDetailsWithDiningAreas(sharedArea), 11, other, "outdoor"),
        { ...standardPreviewRequest, seatingType: "outdoor", diningArea: other },
      );
      expect(sanitized.seatingType).toBe("outdoor");
    });

    it("still fails when the bound category is absent from the response", () => {
      expect(() =>
        sanitizeBookingPreviewResult(
          exactPreviewResult(bookingDetailsWithDiningAreas(sharedArea), 11, other, "bar"),
          { ...standardPreviewRequest, diningArea: other },
        ),
      ).toThrow(/BOOKING_PREVIEW_DINING_AREA_MISMATCH/u);
    });

    it("still fails when the same id and category are repeated", () => {
      expect(() =>
        sanitizeBookingPreviewResult(
          exactPreviewResult(
            bookingDetailsWithDiningAreas([
              { diningAreaId: 11, tableCategory: "outdoor" },
              { diningAreaId: 11, tableCategory: "Outdoor" },
            ]),
            11,
            other,
            "outdoor",
          ),
          { ...standardPreviewRequest, seatingType: "outdoor", diningArea: other },
        ),
      ).toThrow(/BOOKING_PREVIEW_DINING_AREA_AMBIGUOUS/u);
    });
  });

  it("fails closed when an exact provider identity appears more than once", () => {
    expect(() =>
      sanitizeBookingPreviewResult(
        exactPreviewResult(bookingDetailsWithDiningAreas([
          { diningAreaId: 11, tableCategory: "default" },
          { diningAreaId: 11, tableCategory: "Default" },
        ]), 11),
        standardPreviewRequest,
      ),
    ).toThrow(/BOOKING_PREVIEW_DINING_AREA_AMBIGUOUS/u);
  });
});

function providerRestaurant(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    restaurantId: 70204,
    name: "Catch New York",
    urls: { profileLink: { link: "https://www.opentable.com/r/catch-new-york?ref=search" } },
    primaryCuisine: { name: "Seafood" },
    metro: { name: "New York" },
    priceBand: "3",
    type: "Restaurant",
    ...overrides,
  };
}

describe("sanitizeSearchResults", () => {
  it("projects only safe fields onto the bridge payload", () => {
    const sanitized = sanitizeSearchResults({
      multiSearch: { restaurants: [providerRestaurant()] },
      providerState: { secret: true },
    });

    expect(sanitized.results).toEqual([
      {
        restaurantId: "70204",
        name: "Catch New York",
        profileUrl: "https://www.opentable.com/r/catch-new-york",
        bookable: true,
        cuisine: "Seafood",
        metro: "New York",
        priceBand: "3",
      },
    ]);
  });

  it("drops entries without a usable identity or profile link", () => {
    const sanitized = sanitizeSearchResults({
      multiSearch: {
        restaurants: [
          providerRestaurant(),
          providerRestaurant({
            restaurantId: 11,
            urls: { profileLink: { link: "https://evil.example/r/not-opentable" } },
          }),
          providerRestaurant({ restaurantId: 12, name: "" }),
        ],
      },
    });

    expect(sanitized.results.map((result) => result.restaurantId)).toEqual(["70204"]);
  });

  it("caps the result list", () => {
    const restaurants = Array.from({ length: 40 }, (_value, index) =>
      providerRestaurant({ restaurantId: 1_000 + index }),
    );
    expect(
      sanitizeSearchResults({ multiSearch: { restaurants } }).results,
    ).toHaveLength(30);
  });

  it("returns an empty list when the provider reports no matches", () => {
    expect(
      sanitizeSearchResults({ multiSearch: { restaurants: [] } }).results,
    ).toEqual([]);
  });

  it("fails closed when the provider state shape changes", () => {
    expect(() => sanitizeSearchResults({ searchResults: [] })).toThrow(
      /restaurant list/u,
    );
  });

  it("marks listing-type venues as not bookable", () => {
    const sanitized = sanitizeSearchResults({
      multiSearch: { restaurants: [providerRestaurant({ type: "Listing" })] },
    });
    expect(sanitized.results[0]?.bookable).toBe(false);
  });
});
