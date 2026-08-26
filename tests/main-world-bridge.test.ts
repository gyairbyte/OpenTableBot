import { describe, expect, it } from "vitest";
import {
  attachPreviewReferences,
  extractInitialStateFromHtml,
  findAvailabilityOperation,
  installAvailabilityApolloBridge,
  mergeAvailabilityVariables,
  exactIntentMatch,
  beginPreparedSubmission,
  type PreparedRecord,
} from "../extension/src/main-world.js";

describe("MAIN-world Apollo bridge", () => {
  function prepared(overrides: Partial<PreparedRecord> = {}): PreparedRecord {
    return {
      expiresAt: 2_000,
      intent: { slotId: "slot-1" },
      previewReference: "00000000-0000-4000-8000-000000000001",
      slotLockId: "browser-only-lock",
      diningAreaId: 1,
      correlationId: "browser-only-correlation",
      lockOperationId: "lock-operation-1",
      state: "REVALIDATED",
      ...overrides,
    };
  }

  it("atomically makes a prepared handle single-use", () => {
    const record = prepared();
    expect(beginPreparedSubmission(record, { slotId: "slot-1" }, 1_000)).toEqual({ kind: "begin" });
    expect(record.state).toBe("SUBMITTING");
    expect(() => beginPreparedSubmission(record, { slotId: "slot-1" }, 1_000)).toThrow("DUPLICATE_SUBMISSION_PREVENTED");
  });

  it("rejects an expired prepared handle before dispatch", () => {
    const record = prepared({ expiresAt: 999 });
    expect(() => beginPreparedSubmission(record, { slotId: "slot-1" }, 1_000)).toThrow("LOCK_EXPIRED");
    expect(record.state).toBe("FAILED_DEFINITIVE");
  });

  it.each(["PENDING_ACK", "ACKNOWLEDGED", "ORPHANED"] as const)(
    "rejects non-revalidated prepared state %s before dispatch",
    (state) => {
      const record = prepared({ state });
      expect(() => beginPreparedSubmission(record, { slotId: "slot-1" }, 1_000)).toThrow(
        "DUPLICATE_SUBMISSION_PREVENTED",
      );
      expect(record.state).toBe(state);
    },
  );

  it("returns a cached OUTCOME_UNKNOWN without starting another dispatch", () => {
    const terminal = { status: "outcome-unknown", message: "do not retry" };
    const record = prepared({ state: "OUTCOME_UNKNOWN", terminalResult: terminal });
    expect(beginPreparedSubmission(record, { slotId: "slot-1" }, 1_000)).toEqual({ kind: "cached", result: terminal });
  });

  it("rejects a forged or stale prepared intent", () => {
    expect(() => beginPreparedSubmission(prepared(), { slotId: "forged" }, 1_000)).toThrow("BOOKING_INVARIANT_MISMATCH");
  });
  it.each([
    ["restaurantId", "restaurant-999"],
    ["date", "2026-09-02"],
    ["time", "19:15"],
    ["partySize", 3],
    ["seatingType", "bar"],
    ["reservationKind", { kind: "experience", experienceId: "1" }],
  ])("rejects a lock intent with mismatched %s", (field, value) => {
    const intent = {
      targetId: "target-1",
      slotId: "slot-1",
      restaurantId: "restaurant-123",
      date: "2026-09-01",
      time: "19:00",
      partySize: 2,
      seatingType: "standard",
      reservationKind: { kind: "standard" },
    };
    expect(exactIntentMatch(intent, { ...intent, [field]: value })).toBe(false);
  });
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
