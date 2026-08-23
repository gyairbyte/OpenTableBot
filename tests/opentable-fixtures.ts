import type { AvailabilityObservation } from "../src/opentable/browser/availability-types.js";

export function makeAvailabilityObservation(
  overrides: Partial<AvailabilityObservation> = {},
): AvailabilityObservation {
  return {
    requestContext: {
      restaurantIds: ["restaurant-123"],
      date: "2026-09-01",
      time: "19:00",
      partySize: 2,
    },
    payload: {
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
                  },
                ],
              },
            ],
          },
        ],
      },
    },
    ...overrides,
  };
}
