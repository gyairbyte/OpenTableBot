import { describe, expect, it } from "vitest";
import { extractAvailabilityRequestContext } from "../src/opentable/playwright/availability-observer.js";

describe("availability request context extraction", () => {
  it("extracts invariant fields from normal GraphQL variables", () => {
    const variables = encodeURIComponent(
      JSON.stringify({
        restaurantIds: [123],
        date: "2026-09-01",
        time: "19:00",
        partySize: 2,
      }),
    );
    expect(
      extractAvailabilityRequestContext(
        `https://www.opentable.com/dapi/fe/gql?opname=RestaurantsAvailability&variables=${variables}`,
        undefined,
      ),
    ).toEqual({
      restaurantIds: ["123"],
      date: "2026-09-01",
      time: "19:00",
      partySize: 2,
    });
  });

  it("extracts invariant fields from POST variables", () => {
    expect(
      extractAvailabilityRequestContext(
        "https://www.opentable.com/dapi/fe/gql?opname=RestaurantsAvailability",
        {
          variables: {
            restaurantIds: ["restaurant-123"],
            dateTime: "2026-09-01T19:00",
            covers: 2,
          },
        },
      ),
    ).toEqual({
      restaurantIds: ["restaurant-123"],
      date: "2026-09-01",
      time: "19:00",
      partySize: 2,
    });
  });
});
