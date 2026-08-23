import { describe, expect, it } from "vitest";
import { OpenTableAdapterError } from "../src/opentable/errors.js";
import {
  localDateTimeToOffsetIso,
  normalizeAvailabilityObservation,
} from "../src/opentable/browser/slot-normalizer.js";
import { makeTarget } from "./fixtures.js";
import { makeAvailabilityObservation } from "./opentable-fixtures.js";

describe("availability slot normalization", () => {
  it("normalizes a valid availability response", () => {
    const result = normalizeAvailabilityObservation(
      makeAvailabilityObservation(),
      makeTarget(),
      "2026-09-01",
    );

    expect(result.slots).toHaveLength(1);
    expect(result.slots[0]).toMatchObject({
      restaurantId: "restaurant-123",
      localDate: "2026-09-01",
      localTime: "18:30",
      startsAt: "2026-09-01T18:30:00-04:00",
      partySize: 2,
      seatingType: "standard",
    });
  });

  it("returns no slots for a verified empty response", () => {
    const observation = makeAvailabilityObservation({
      payload: {
        data: {
          availability: [
            {
              restaurantId: "restaurant-123",
              availabilityDays: [{ dayOffset: 0, slots: [] }],
            },
          ],
        },
      },
    });
    expect(
      normalizeAvailabilityObservation(
        observation,
        makeTarget(),
        "2026-09-01",
      ).slots,
    ).toEqual([]);
  });

  it("emits each known seating type represented by a slot", () => {
    const observation = makeAvailabilityObservation({
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
                      timeOffsetMinutes: 0,
                      attributes: ["default", "outdoor", "highTop"],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    });
    const result = normalizeAvailabilityObservation(
      observation,
      makeTarget(),
      "2026-09-01",
    );
    expect(result.slots.map((slot) => slot.seatingType)).toEqual([
      "high-top",
      "outdoor",
      "standard",
    ]);
  });

  it("maps unknown seating to other and retains sanitized diagnostics", () => {
    const observation = makeAvailabilityObservation({
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
                      timeOffsetMinutes: 0,
                      attributes: ["Garden Room\u0000"],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    });
    const result = normalizeAvailabilityObservation(
      observation,
      makeTarget(),
      "2026-09-01",
    );
    expect(result.slots[0]?.seatingType).toBe("other");
    expect(result.diagnostics).toEqual([
      { code: "UNKNOWN_SEATING_LABEL", label: "Garden Room" },
    ]);
  });

  it("fails closed for the wrong restaurant", () => {
    const observation = makeAvailabilityObservation({
      payload: {
        data: {
          availability: [
            {
              restaurantId: "different-restaurant",
              availabilityDays: [{ dayOffset: 0, slots: [] }],
            },
          ],
        },
      },
    });
    expect(() =>
      normalizeAvailabilityObservation(
        observation,
        makeTarget(),
        "2026-09-01",
      ),
    ).toThrow(OpenTableAdapterError);
  });

  it("fails closed for a wrong request date", () => {
    const observation = makeAvailabilityObservation({
      requestContext: {
        ...makeAvailabilityObservation().requestContext,
        date: "2026-09-02",
      },
    });
    expect(() =>
      normalizeAvailabilityObservation(
        observation,
        makeTarget(),
        "2026-09-01",
      ),
    ).toThrow(/date did not match/);
  });

  it("fails closed for a wrong party size", () => {
    const observation = makeAvailabilityObservation({
      requestContext: {
        ...makeAvailabilityObservation().requestContext,
        partySize: 4,
      },
    });
    expect(() =>
      normalizeAvailabilityObservation(
        observation,
        makeTarget(),
        "2026-09-01",
      ),
    ).toThrow(/party size did not match/);
  });

  it("fails closed for a malformed payload", () => {
    expect(() =>
      normalizeAvailabilityObservation(
        makeAvailabilityObservation({ payload: { data: {} } }),
        makeTarget(),
        "2026-09-01",
      ),
    ).toThrow(/Malformed availability payload/);
  });

  it("derives DST-correct offsets and rejects ambiguous local time", () => {
    expect(
      localDateTimeToOffsetIso(
        "2026-07-01",
        "19:00",
        "America/New_York",
      ),
    ).toBe("2026-07-01T19:00:00-04:00");
    expect(
      localDateTimeToOffsetIso(
        "2026-12-01",
        "19:00",
        "America/New_York",
      ),
    ).toBe("2026-12-01T19:00:00-05:00");
    expect(() =>
      localDateTimeToOffsetIso(
        "2026-11-01",
        "01:30",
        "America/New_York",
      ),
    ).toThrow(/ambiguous or invalid/);
  });
});
