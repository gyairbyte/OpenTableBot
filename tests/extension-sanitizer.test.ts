import { describe, expect, it } from "vitest";
import { sanitizeAvailabilityResult } from "../extension/src/content.js";

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
});
