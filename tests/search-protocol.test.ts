import { describe, expect, it } from "vitest";
import { SafeSearchResultsSchema } from "../src/opentable/browser/search-types.js";
import {
  BRIDGE_PROTOCOL_VERSION,
  BridgeMessageSchema,
  SearchRestaurantsRequestPayloadSchema,
} from "../src/opentable/bridge/protocol.js";

const validResult = {
  restaurantId: "70204",
  name: "Catch New York",
  profileUrl: "https://www.opentable.com/r/catch-new-york",
  bookable: true,
};

describe("SafeSearchResultsSchema", () => {
  it("accepts bounded results with optional detail fields", () => {
    const parsed = SafeSearchResultsSchema.parse({
      results: [
        {
          ...validResult,
          cuisine: "Seafood",
          metro: "New York",
          priceBand: "$$$",
        },
      ],
    });
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0]?.restaurantId).toBe("70204");
  });

  it("accepts an empty result list", () => {
    expect(SafeSearchResultsSchema.parse({ results: [] }).results).toEqual([]);
  });

  it("rejects unknown provider fields", () => {
    expect(() =>
      SafeSearchResultsSchema.parse({
        results: [{ ...validResult, rawPayload: { slots: [] } }],
      }),
    ).toThrow();
  });

  it("rejects more than 30 results", () => {
    const results = Array.from({ length: 31 }, (_value, index) => ({
      ...validResult,
      restaurantId: `restaurant-${index}`,
    }));
    expect(() => SafeSearchResultsSchema.parse({ results })).toThrow();
  });

  it("rejects an empty restaurant name", () => {
    expect(() =>
      SafeSearchResultsSchema.parse({ results: [{ ...validResult, name: "" }] }),
    ).toThrow();
  });
});

describe("SearchRestaurantsRequestPayloadSchema", () => {
  it("accepts a term with optional date, time and party size", () => {
    const parsed = SearchRestaurantsRequestPayloadSchema.parse({
      term: "sushi",
      date: "2026-10-23",
      time: "17:00",
      partySize: 2,
    });
    expect(parsed).toEqual({
      term: "sushi",
      date: "2026-10-23",
      time: "17:00",
      partySize: 2,
    });
  });

  it("rejects an empty or oversized term", () => {
    expect(() => SearchRestaurantsRequestPayloadSchema.parse({ term: "" })).toThrow();
    expect(() =>
      SearchRestaurantsRequestPayloadSchema.parse({ term: "x".repeat(201) }),
    ).toThrow();
  });

  it("rejects an out-of-range party size", () => {
    expect(() =>
      SearchRestaurantsRequestPayloadSchema.parse({ term: "sushi", partySize: 0 }),
    ).toThrow();
    expect(() =>
      SearchRestaurantsRequestPayloadSchema.parse({ term: "sushi", partySize: 51 }),
    ).toThrow();
  });

  it("rejects a malformed date or time", () => {
    expect(() =>
      SearchRestaurantsRequestPayloadSchema.parse({ term: "sushi", date: "23-10-2026" }),
    ).toThrow();
    expect(() =>
      SearchRestaurantsRequestPayloadSchema.parse({ term: "sushi", time: "5pm" }),
    ).toThrow();
  });
});

describe("search bridge messages", () => {
  it("accepts a SEARCH_RESTAURANTS request", () => {
    const parsed = BridgeMessageSchema.parse({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      id: "search-request-1",
      type: "SEARCH_RESTAURANTS",
      request: { term: "sushi", partySize: 2 },
      deadlineEpochMs: 1_800_000_000_000,
    });
    expect(parsed.type).toBe("SEARCH_RESTAURANTS");
  });

  it("accepts a SEARCH_RESTAURANTS_RESULT", () => {
    const parsed = BridgeMessageSchema.parse({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      id: "search-response-1",
      type: "SEARCH_RESTAURANTS_RESULT",
      request: { term: "sushi" },
      data: { results: [validResult] },
    });
    expect(parsed.type).toBe("SEARCH_RESTAURANTS_RESULT");
  });

  it("rejects a result carrying provider fields", () => {
    expect(() =>
      BridgeMessageSchema.parse({
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        id: "search-response-2",
        type: "SEARCH_RESTAURANTS_RESULT",
        request: { term: "sushi" },
        data: { results: [{ ...validResult, priceRangeId: 3 }] },
      }),
    ).toThrow();
  });
});
