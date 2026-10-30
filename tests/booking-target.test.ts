import { describe, expect, it } from "vitest";
import {
  BookingTargetSchema,
  effectiveDiningAreaPolicy,
} from "../src/domain/booking-target.js";
import { makeTarget } from "./fixtures.js";

describe("BookingTarget schema", () => {
  it("accepts a valid pre-authorized target", () => {
    expect(BookingTargetSchema.parse(makeTarget())).toEqual(makeTarget());
  });

  it("keeps the acceptAnyTimeInWindow opt-in when parsing", () => {
    const target = makeTarget({ acceptAnyTimeInWindow: true });

    expect(BookingTargetSchema.parse(target).acceptAnyTimeInWindow).toBe(true);
    expect(BookingTargetSchema.parse(makeTarget()).acceptAnyTimeInWindow).toBeUndefined();
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

  it("defaults to ANY dining area when neither policy form is supplied", () => {
    const target = { ...makeTarget(), allowedSeatingTypes: undefined };
    expect(effectiveDiningAreaPolicy(target)).toEqual({
      mode: "any",
      selection: "provider-order",
    });
  });

  it("maps legacy seating configuration to a deterministic ALLOW policy", () => {
    expect(effectiveDiningAreaPolicy(makeTarget())).toEqual({
      mode: "allow",
      categories: ["dining-room", "outdoor"],
      labels: [],
      selection: "provider-order",
    });
  });

  it("rejects conflicting legacy and generalized dining-area policies", () => {
    expect(BookingTargetSchema.safeParse(makeTarget({
      diningAreaPolicy: { mode: "any", selection: "provider-order" },
    })).success).toBe(false);
  });

  it("migrates legacy cent-based policy caps to dollars", () => {
    const legacy = JSON.parse(JSON.stringify(makeTarget())) as {
      bookingPolicy: Record<string, unknown>;
    };
    delete legacy.bookingPolicy.maxAuthorizedPrepaidDollars;
    delete legacy.bookingPolicy.maxAuthorizedCancellationNoShowDollarsPerPerson;
    legacy.bookingPolicy.maxAuthorizedPrepaidCents = 10_000;
    legacy.bookingPolicy.maxAuthorizedCancellationNoShowCents = 5_000;

    const parsed = BookingTargetSchema.parse(legacy);
    expect(parsed.bookingPolicy.maxAuthorizedPrepaidDollars).toBe(100);
    // The legacy cap was a per-booking total; the fixture party of 2 gives $25/person.
    expect(parsed.bookingPolicy.maxAuthorizedCancellationNoShowDollarsPerPerson).toBe(25);
  });

  it("rounds a divided legacy cancellation/no-show cap down to the cent", () => {
    const legacy = JSON.parse(JSON.stringify(makeTarget({ partySize: 3 }))) as {
      bookingPolicy: Record<string, unknown>;
    };
    delete legacy.bookingPolicy.maxAuthorizedCancellationNoShowDollarsPerPerson;
    legacy.bookingPolicy.maxAuthorizedCancellationNoShowCents = 5_000;

    const parsed = BookingTargetSchema.parse(legacy);
    // floor(5000 / 3) cents per person keeps the total at or below the old cap.
    expect(parsed.bookingPolicy.maxAuthorizedCancellationNoShowDollarsPerPerson).toBe(16.66);
  });

  it("lets new dollar fields win over legacy cent fields", () => {
    const legacy = JSON.parse(JSON.stringify(makeTarget())) as {
      bookingPolicy: Record<string, unknown>;
    };
    legacy.bookingPolicy.maxAuthorizedPrepaidCents = 10_000;

    const parsed = BookingTargetSchema.parse(legacy);
    expect(parsed.bookingPolicy.maxAuthorizedPrepaidDollars).toBe(100);
  });

  it("rejects dollar caps with sub-cent fractions", () => {
    const result = BookingTargetSchema.safeParse(
      makeTarget({
        bookingPolicy: {
          ...makeTarget().bookingPolicy,
          maxAuthorizedCancellationNoShowDollarsPerPerson: 35.001,
        },
      }),
    );
    expect(result.success).toBe(false);
  });
});
