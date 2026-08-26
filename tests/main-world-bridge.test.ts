import { describe, expect, it } from "vitest";
import {
  attachPreviewReferences,
  extractInitialStateFromHtml,
  findAvailabilityOperation,
  installAvailabilityApolloBridge,
  mergeAvailabilityVariables,
} from "../extension/src/main-world.js";

describe("MAIN-world Apollo bridge", () => {
  it("reports unavailable instead of falling back to arbitrary execution", () => {
    const fakeWindow = { __APOLLO_CLIENT__: {}, setInterval, clearInterval };
    expect(installAvailabilityApolloBridge(fakeWindow as never)).toBe(false);
  });

  it("selects only the exact read-only RestaurantsAvailability operation", () => {
    const availability = {
      operationName: "RestaurantsAvailability",
      variables: { restaurantIds: ["994474"] },
      extensions: { persistedQuery: { sha256Hash: "page-owned-value" } },
    };
    expect(findAvailabilityOperation([availability, { operationName: "OtherQuery" }])).toEqual({
      operation: availability,
      payloadWasArray: true,
    });
    expect(findAvailabilityOperation({ operationName: "BookReservation" })).toBeUndefined();
    expect(findAvailabilityOperation({ operationName: "RestaurantsAvailabilityWrite" })).toBeUndefined();
  });

  it("keeps page-owned tokens in Chrome and filters them to the requested restaurant", () => {
    expect(
      mergeAvailabilityVariables(
        {
          restaurantIds: ["other"],
          date: "2026-08-23",
          restaurantAvailabilityTokens: [
            { restaurantId: "994474", availabilityToken: "page-secret" },
            { restaurantId: "other", availabilityToken: "unrelated-secret" },
          ],
          pageOwnedFlag: true,
        },
        {
          restaurantIds: ["994474"],
          date: "2026-08-29",
          partySize: 2,
          unapprovedOverride: "must-not-cross-operation-boundary",
        },
      ),
    ).toEqual({
      restaurantIds: ["994474"],
      date: "2026-08-29",
      partySize: 2,
      restaurantAvailabilityTokens: [
        { restaurantId: "994474", availabilityToken: "page-secret" },
      ],
      pageOwnedFlag: true,
    });
  });

  it("supports current positionally aligned page-owned token arrays", () => {
    expect(
      mergeAvailabilityVariables(
        {
          restaurantIds: ["other", "994474", "third"],
          restaurantAvailabilityTokens: [
            "other-secret",
            "don-angie-secret",
            "third-secret",
          ],
          slotDiscovery: { pageOwned: true },
        },
        { restaurantIds: ["994474"], date: "2026-08-29", partySize: 2 },
      ),
    ).toEqual({
      restaurantIds: ["994474"],
      restaurantAvailabilityTokens: ["don-angie-secret"],
      slotDiscovery: { pageOwned: true },
      date: "2026-08-29",
      partySize: 2,
    });
  });

  it("replays exact matching page variables unchanged to preserve attribution metadata", () => {
    const captured = {
      restaurantIds: ["994474", "other"],
      restaurantAvailabilityTokens: ["don-angie-secret", "other-secret"],
      date: "2026-08-29",
      time: "19:00:00",
      partySize: 2,
      databaseRegion: "NA",
      attributionToken: "page-owned-attribution",
    };
    expect(
      mergeAvailabilityVariables(captured, {
        restaurantIds: ["994474"],
        date: "2026-08-29",
        time: "19:00",
        partySize: 2,
        databaseRegion: "NA",
      }),
    ).toEqual(captured);
  });

  it("adds a browser-local preview handle without replacing provider slot data", () => {
    const result = attachPreviewReferences(
      {
        data: {
          availability: [
            {
              restaurantId: "994474",
              availabilityDays: [
                {
                  dayOffset: 0,
                  slots: [
                    {
                      isAvailable: true,
                      timeOffsetMinutes: 15,
                      type: "Standard",
                      attributes: ["default"],
                      slotHash: "page-owned-hash",
                      slotAvailabilityToken: "page-owned-token",
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
      { date: "2026-08-29", time: "19:00", partySize: 2 },
    ) as {
      data: { availability: Array<{ availabilityDays: Array<{ slots: Array<Record<string, unknown>> }> }> };
    };
    expect(
      result.data.availability[0]?.availabilityDays[0]?.slots[0]?.previewReference,
    ).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("extracts booking-details state as JSON without evaluating scripts", () => {
    const state = extractInitialStateFromHtml(
      '<script>window.__INITIAL_STATE__ = {"restaurant":{"restaurantId":994474},"text":"brace } in string"}; window.evil()</script>',
    );
    expect(state).toEqual({
      restaurant: { restaurantId: 994474 },
      text: "brace } in string",
    });
  });
});
