import { describe, expect, it } from "vitest";
import {
  evaluateBookingPreview,
  PolicyRejectionReason,
} from "../src/domain/booking-policy.js";
import {
  BookingPreviewSchema,
  type BookingPreview,
} from "../src/domain/reservation-slot.js";
import { makePreview, makeSlot, makeTarget } from "./fixtures.js";

describe("booking preview financial policy", () => {
  it("accepts unknown currency when every financial exposure is confirmed zero", () => {
    expect(evaluateBookingPreview(makeTarget(), makeSlot(), makePreview({ currency: { status: "unknown" } }))).toEqual({ allowed: true });
  });

  it.each([
    ["prepaid", { prepaid: { status: "required-known", amountCents: 100 } }],
    ["cancellation", { cancellationFee: { status: "known", amountCents: 100 } }],
    ["no-show", { noShowFee: { status: "known", amountCents: 100 } }],
  ] as const)("rejects unknown currency with %s exposure", (_name, override) => {
    const result = evaluateBookingPreview(
      makeTarget(),
      makeSlot(),
      makePreview({ ...override, currency: { status: "unknown" } }),
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reasons).toContain(PolicyRejectionReason.CURRENCY_UNKNOWN);
  });
  it("passes confirmed no cancellation or no-show fee", () => {
    expect(
      evaluateBookingPreview(makeTarget(), makeSlot(), makePreview()),
    ).toEqual({ allowed: true });
  });

  it("passes known cancellation and no-show fees at or below the limit", () => {
    const preview = makePreview({
      cancellationFee: { status: "known", amountCents: 4_999 },
      noShowFee: { status: "known", amountCents: 5_000 },
    });

    expect(evaluateBookingPreview(makeTarget(), makeSlot(), preview)).toEqual({
      allowed: true,
    });
  });

  it("rejects a known fee above the authorized limit", () => {
    const result = evaluateBookingPreview(
      makeTarget(),
      makeSlot(),
      makePreview({
        cancellationFee: { status: "known", amountCents: 5_001 },
      }),
    );

    expect(result).toEqual({
      allowed: false,
      reasons: [
        PolicyRejectionReason.CANCELLATION_EXPOSURE_EXCEEDS_AUTHORIZATION,
      ],
    });
  });

  it("fails closed on an unknown cancellation fee", () => {
    const result = evaluateBookingPreview(
      makeTarget(),
      makeSlot(),
      makePreview({ cancellationFee: { status: "unknown" } }),
    );

    expect(result).toEqual({
      allowed: false,
      reasons: [PolicyRejectionReason.CANCELLATION_FEE_UNKNOWN],
    });
  });

  it("fails closed on an unknown no-show fee", () => {
    const result = evaluateBookingPreview(
      makeTarget(),
      makeSlot(),
      makePreview({ noShowFee: { status: "unknown" } }),
    );

    expect(result).toEqual({
      allowed: false,
      reasons: [PolicyRejectionReason.NO_SHOW_FEE_UNKNOWN],
    });
  });

  it("passes a known prepaid amount within authorization", () => {
    const result = evaluateBookingPreview(
      makeTarget(),
      makeSlot(),
      makePreview({
        prepaid: { status: "required-known", amountCents: 10_000 },
      }),
    );

    expect(result).toEqual({ allowed: true });
  });

  it("rejects an excessive prepaid amount", () => {
    const result = evaluateBookingPreview(
      makeTarget(),
      makeSlot(),
      makePreview({
        prepaid: { status: "required-known", amountCents: 10_001 },
      }),
    );

    expect(result).toEqual({
      allowed: false,
      reasons: [PolicyRejectionReason.PREPAID_AMOUNT_EXCEEDS_AUTHORIZATION],
    });
  });

  it("scales the per-person cancellation/no-show cap by the party size", () => {
    const slot = makeSlot({ partySize: 3 });
    const target = makeTarget({
      partySize: 3,
      bookingPolicy: {
        ...makeTarget().bookingPolicy,
        maxAuthorizedCancellationNoShowDollarsPerPerson: 35,
      },
    });
    // "$35 per person" at a party of 3 parses to a $105 total.
    const preview = makePreview({
      partySize: 3,
      cancellationFee: { status: "known", amountCents: 10_500 },
    });

    expect(evaluateBookingPreview(target, slot, preview)).toEqual({ allowed: true });

    expect(
      evaluateBookingPreview(target, slot, {
        ...preview,
        cancellationFee: { status: "known", amountCents: 10_501 },
      }),
    ).toMatchObject({
      allowed: false,
      reasons: [PolicyRejectionReason.CANCELLATION_EXPOSURE_EXCEEDS_AUTHORIZATION],
    });
  });

  it("fails closed when a required prepaid amount is unknown", () => {
    const result = evaluateBookingPreview(
      makeTarget(),
      makeSlot(),
      makePreview({ prepaid: { status: "required-unknown" } }),
    );

    expect(result).toEqual({
      allowed: false,
      reasons: [PolicyRejectionReason.PREPAID_AMOUNT_UNKNOWN],
    });
  });

  it("does not create an artificial charge when prepaid is not required", () => {
    const parsed = BookingPreviewSchema.parse(
      makePreview({ prepaid: { status: "not-required" } }),
    );

    expect(parsed.prepaid).toEqual({ status: "not-required" });
    expect(evaluateBookingPreview(makeTarget(), makeSlot(), parsed)).toEqual({
      allowed: true,
    });
  });

  it("rejects an unexpected prepaid requirement", () => {
    const target = makeTarget({
      bookingPolicy: {
        ...makeTarget().bookingPolicy,
        allowPrepaid: false,
      },
    });
    const result = evaluateBookingPreview(
      target,
      makeSlot(),
      makePreview({
        prepaid: { status: "required-known", amountCents: 100 },
      }),
    );

    expect(result).toEqual({
      allowed: false,
      reasons: [PolicyRejectionReason.UNEXPECTED_PREPAID_REQUIREMENT],
    });
  });
});

describe("financial term schemas", () => {
  it("rejects known financial terms without an amount", () => {
    const preview = {
      ...makePreview(),
      cancellationFee: { status: "known" },
    };

    expect(BookingPreviewSchema.safeParse(preview).success).toBe(false);
  });

  it("rejects amounts on terms confirmed as none or not required", () => {
    expect(
      BookingPreviewSchema.safeParse({
        ...makePreview(),
        cancellationFee: { status: "none", amountCents: 0 },
      }).success,
    ).toBe(false);
    expect(
      BookingPreviewSchema.safeParse({
        ...makePreview(),
        prepaid: { status: "not-required", amountCents: 0 },
      }).success,
    ).toBe(false);
  });

  it("rejects omitted or legacy ambiguous financial fields", () => {
    const withoutCancellationFee: Partial<BookingPreview> = makePreview();
    delete withoutCancellationFee.cancellationFee;
    expect(
      BookingPreviewSchema.safeParse(withoutCancellationFee).success,
    ).toBe(false);
    expect(
      BookingPreviewSchema.safeParse({
        ...makePreview(),
        cancellationFeeCents: 0,
      }).success,
    ).toBe(false);
  });

  it("rejects negative or fractional known amounts", () => {
    expect(
      BookingPreviewSchema.safeParse({
        ...makePreview(),
        noShowFee: { status: "known", amountCents: -1 },
      }).success,
    ).toBe(false);
    expect(
      BookingPreviewSchema.safeParse({
        ...makePreview(),
        prepaid: { status: "required-known", amountCents: 10.5 },
      }).success,
    ).toBe(false);
  });
});

describe("other fail-closed preview checks", () => {
  it("rejects ambiguous, 3DS, unexpected seating, or date mismatch", () => {
    const result = evaluateBookingPreview(
      makeTarget(),
      makeSlot(),
      makePreview({
        isAmbiguous: true,
        strongAuthentication: "required",
        seatingType: "bar",
        localDate: "2026-09-02",
      }),
    );

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reasons).toEqual(
        expect.arrayContaining([
          PolicyRejectionReason.AMBIGUOUS_PREVIEW,
          PolicyRejectionReason.STRONG_CUSTOMER_AUTHENTICATION_REQUIRED,
          PolicyRejectionReason.UNEXPECTED_SEATING,
          PolicyRejectionReason.DATE_MISMATCH,
        ]),
      );
    }
  });
});
