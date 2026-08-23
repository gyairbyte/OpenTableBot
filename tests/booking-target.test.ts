import { describe, expect, it } from "vitest";
import { BookingTargetSchema } from "../src/domain/booking-target.js";
import { makeTarget } from "./fixtures.js";

describe("BookingTarget schema", () => {
  it("accepts a valid pre-authorized target", () => {
    expect(BookingTargetSchema.parse(makeTarget())).toEqual(makeTarget());
  });

  it("rejects inverted date and time windows", () => {
    const result = BookingTargetSchema.safeParse(
      makeTarget({
        dateRange: { startDate: "2026-09-02", endDate: "2026-09-01" },
        timeWindow: { earliest: "20:00", latest: "18:00", preferred: "19:00" },
      }),
    );

    expect(result.success).toBe(false);
  });

  it("rejects a preferred time outside the acceptable window", () => {
    const result = BookingTargetSchema.safeParse(
      makeTarget({
        timeWindow: { earliest: "18:00", latest: "20:00", preferred: "20:30" },
      }),
    );

    expect(result.success).toBe(false);
  });

  it("requires a valid restaurant IANA time zone", () => {
    expect(
      BookingTargetSchema.safeParse(
        makeTarget({
          restaurant: {
            ...makeTarget().restaurant,
            timeZone: "Eastern Time",
          },
        }),
      ).success,
    ).toBe(false);
    expect(
      BookingTargetSchema.safeParse(
        makeTarget({
          restaurant: {
            ...makeTarget().restaurant,
            timeZone: "America/Los_Angeles",
          },
        }),
      ).success,
    ).toBe(true);
  });
});
