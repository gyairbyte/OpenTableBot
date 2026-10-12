import { describe, expect, it } from "vitest";
import {
  assertExecutablePaymentTerms,
  attachPreviewReferences,
  extractInitialStateFromHtml,
  findAvailabilityOperation,
  installAvailabilityApolloBridge,
  installAvailabilityFetchBridge,
  mergeAvailabilityVariables,
  matchRestaurantIdType,
  exactIntentMatch,
  beginPreparedSubmission,
  buildStandardLockRequest,
  classifyLockHttpFailure,
  hasRequiredPreviewWriteState,
  type PreparedRecord,
} from "../extension/src/main-world.js";

describe("assertExecutablePaymentTerms", () => {
  // A card-backed reservation with exact "$35 per person" fees, as previewed.
  const feeBackedPreview = {
    prepaid: { status: "not-required" },
    cancellationFee: { status: "known", amountCents: 10_500 },
    noShowFee: { status: "known", amountCents: 10_500 },
    currency: { status: "known", code: "USD" },
    paymentRequirement: "required",
    strongAuthentication: "not-required",
  };
  const freePreview = {
    ...feeBackedPreview,
    cancellationFee: { status: "none" },
    noShowFee: { status: "none" },
    paymentRequirement: "not-required",
  };

  it("allows a fee-backed reservation when the provider agrees", () => {
    expect(() =>
      assertExecutablePaymentTerms(feeBackedPreview, { creditCardRequired: true }),
    ).not.toThrow();
  });

  it("allows a reservation with no payment requirement", () => {
    expect(() =>
      assertExecutablePaymentTerms(freePreview, { creditCardRequired: false }),
    ).not.toThrow();
  });

  it("refuses a prepaid deposit", () => {
    expect(() =>
      assertExecutablePaymentTerms(
        { ...feeBackedPreview, prepaid: { status: "required", amountCents: 5_000 } },
        { creditCardRequired: true },
      ),
    ).toThrow(/PAYMENT_REQUIRED/);
  });

  it("refuses unreadable payment terms", () => {
    expect(() =>
      assertExecutablePaymentTerms(
        { ...feeBackedPreview, cancellationFee: { status: "unknown" } },
        { creditCardRequired: true },
      ),
    ).toThrow(/PAYMENT_REQUIRED/);
  });

  it("refuses a known fee without a known currency", () => {
    expect(() =>
      assertExecutablePaymentTerms(
        { ...feeBackedPreview, currency: { status: "unknown" } },
        { creditCardRequired: true },
      ),
    ).toThrow(/PAYMENT_REQUIRED/);
  });

  it("refuses interactive strong authentication", () => {
    expect(() =>
      assertExecutablePaymentTerms(
        { ...feeBackedPreview, strongAuthentication: "required" },
        { creditCardRequired: true },
      ),
    ).toThrow(/SCA_REQUIRED/);
    expect(() =>
      assertExecutablePaymentTerms(feeBackedPreview, {
        creditCardRequired: true,
        strongAuthenticationRequired: true,
      }),
    ).toThrow(/SCA_REQUIRED/);
  });

  it("refuses when the provider disagrees with the previewed terms", () => {
    expect(() =>
      assertExecutablePaymentTerms(feeBackedPreview, { creditCardRequired: false }),
    ).toThrow(/PAYMENT_REQUIRED/);
    expect(() =>
      assertExecutablePaymentTerms(freePreview, { creditCardRequired: true }),
    ).toThrow(/PAYMENT_REQUIRED/);
  });

  it("refuses when the provider did not report payment terms", () => {
    expect(() => assertExecutablePaymentTerms(feeBackedPreview, {})).toThrow(
      /PAYMENT_REQUIRED/,
    );
  });
});

describe("MAIN-world Apollo bridge", () => {
  function prepared(overrides: Partial<PreparedRecord> = {}): PreparedRecord {
    return {
      expiresAt: 2_000,
      intent: { slotId: "slot-1" },
      previewReference: "00000000-0000-4000-8000-000000000001",
      slotLockId: 987654,
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

  it("replays restaurantIds as numbers when the page used numeric IDs", () => {
    expect(
      mergeAvailabilityVariables(
        {
          restaurantIds: [994474],
          date: "2026-08-29",
          time: "19:00:00",
          partySize: 2,
          databaseRegion: "NA",
        },
        {
          restaurantIds: ["994474"],
          date: "2026-10-23",
          time: "17:00",
          partySize: 2,
          databaseRegion: "NA",
        },
      ),
    ).toEqual({
      restaurantIds: [994474],
      date: "2026-10-23",
      time: "17:00",
      partySize: 2,
      databaseRegion: "NA",
    });
  });

  it("keeps string restaurantIds when the page used strings", () => {
    expect(
      matchRestaurantIdType(["994474", "other"], ["994474", "other"]),
    ).toEqual(["994474", "other"]);
  });

  it("adds a browser-local preview handle without replacing provider slot data", () => {    const result = attachPreviewReferences(
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

  it("builds the narrow current Standard lock request without exporting browser credentials", () => {
    const request = buildStandardLockRequest({
      restaurantId: 123,
      reservationDateTime: "2026-09-18T19:00",
      partySize: 2,
      databaseRegion: "NA",
      slotHash: "browser-local-slot-hash",
      diningAreaId: 456,
    });
    expect(request.headers).toEqual({
      accept: "application/json",
      "content-type": "application/json",
      "ot-page-type": "network_details",
      "ot-page-group": "booking",
    });
    expect(request.body).toEqual({
      operationName: "BookDetailsStandardSlotLock",
      variables: {
        input: {
          restaurantId: 123,
          seatingOption: "DEFAULT",
          reservationDateTime: "2026-09-18T19:00",
          partySize: 2,
          databaseRegion: "NA",
          slotHash: "browser-local-slot-hash",
          reservationType: "STANDARD",
          diningAreaId: 456,
        },
      },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: "1100bf68905fd7cb1d4fd0f4504a4954aa28ec45fb22913fa977af8b06fd97fa",
        },
      },
    });
    expect(JSON.stringify(request)).not.toMatch(/cookie|authorization|csrf|slotAvailabilityToken/iu);
  });

  it("includes the page CSRF token on the fallback lock request when provided", () => {
    const request = buildStandardLockRequest(
      {
        restaurantId: 123,
        reservationDateTime: "2026-09-18T19:00",
        partySize: 2,
        databaseRegion: "NA",
        slotHash: "browser-local-slot-hash",
        diningAreaId: 456,
      },
      { csrfToken: "page-csrf-token" },
    );
    expect(request.headers).toEqual({
      accept: "application/json",
      "content-type": "application/json",
      "ot-page-type": "network_details",
      "ot-page-group": "booking",
      "x-csrf-token": "page-csrf-token",
    });
  });

  it("classifies a 403 response without retaining sensitive response text", () => {
    const result = classifyLockHttpFailure(
      "text/html; charset=utf-8",
      "<html><title>Access Denied</title>Reference #18 secret-value https://errors.edgesuite.net/x</html>",
    );
    expect(result).toEqual({ contentKind: "html", category: "edge-access-control" });
    expect(JSON.stringify(result)).not.toContain("secret-value");
    expect(classifyLockHttpFailure("application/json", '{"error":"forbidden"}')).toEqual({
      contentKind: "json",
      category: "application-json",
    });
    expect(classifyLockHttpFailure(null, "forbidden")).toEqual({
      contentKind: "unknown",
      category: "unclassified",
    });
  });

  it("requires an exact refreshed booking preview before write authorization", () => {
    const discoveredArea = { providerId: 456 };
    const detailsState = { timeSlot: { creditCardRequired: false } };
    expect(hasRequiredPreviewWriteState({ exactDiningArea: discoveredArea, detailsState })).toBe(false);
    expect(hasRequiredPreviewWriteState({
      exactDiningArea: discoveredArea,
      detailsState,
      exactPreviewEstablished: true,
    })).toBe(true);
    expect(hasRequiredPreviewWriteState({ detailsState, exactPreviewEstablished: true })).toBe(false);
  });

  it("prefers a captured BookDetailsStandardSlotLock operation over the hardcoded hash", async () => {
    const capturedHash = "captured-hash-from-page";
    const capturedUrl = "https://www.opentable.com/dapi/fe/gql?optype=mutation&opname=BookDetailsStandardSlotLock";
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ data: { lockSlot: { success: true } } }), { status: 200 })) as typeof fetch;
    const fakeWindow = {
      location: { href: "https://www.opentable.com/r/some-restaurant" },
      fetch: fakeFetch,
      setInterval,
      clearInterval,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    installAvailabilityFetchBridge(fakeWindow as unknown as Window);
    await fakeWindow.fetch(capturedUrl, {
      method: "POST",
      body: JSON.stringify({
        operationName: "BookDetailsStandardSlotLock",
        variables: { input: { restaurantId: 1 } },
        extensions: { persistedQuery: { version: 1, sha256Hash: capturedHash } },
      }),
    });
    const request = buildStandardLockRequest({
      restaurantId: 123,
      reservationDateTime: "2026-09-18T19:00",
      partySize: 2,
      databaseRegion: "NA",
      slotHash: "browser-local-slot-hash",
      diningAreaId: 456,
    });
    const body = request.body as Record<string, unknown>;
    expect(body.extensions).toEqual({
      persistedQuery: { version: 1, sha256Hash: capturedHash },
    });
    const variables = body.variables as Record<string, unknown>;
    expect(variables.input).toEqual({
      restaurantId: 123,
      seatingOption: "DEFAULT",
      reservationDateTime: "2026-09-18T19:00",
      partySize: 2,
      databaseRegion: "NA",
      slotHash: "browser-local-slot-hash",
      reservationType: "STANDARD",
      diningAreaId: 456,
    });
  });
});
