import { describe, expect, it } from "vitest";
import {
  sanitizeAvailabilityResult,
  sanitizeBookingPreviewResult,
} from "../extension/src/content.js";

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
      {
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
      },
      {
        slotId: "slot-1",
        previewReference: "00000000-0000-4000-8000-000000000001",
        restaurantId: "994474",
        date: "2026-08-29",
        time: "19:00",
        partySize: 2,
        seatingType: "standard",
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
      diningArea: { id: 1, tableCategory: "default" },
    });
    expect(JSON.stringify(sanitized)).not.toMatch(
      /cookie|authorization|csrf|token|last4|cardId|email|sessionId/iu,
    );
  });

  it("normalizes the structured reservation datetime used by booking-details SSR", () => {
    const sanitized = sanitizeBookingPreviewResult(
      {
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
      },
      {
        slotId: "slot-live-shape",
        previewReference: "00000000-0000-4000-8000-000000000002",
        restaurantId: "1272781",
        date: "2026-08-24",
        time: "19:00",
        partySize: 2,
        seatingType: "standard",
        reservationKind: { kind: "standard" },
      },
    );

    expect(sanitized.reservationDateTime).toBe("2026-08-24T19:00");
  });
});
