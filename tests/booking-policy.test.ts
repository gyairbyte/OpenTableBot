import { describe, expect, it } from "vitest";
import {
  evaluateBookingPreview,
  PolicyRejectionReason,
} from "../src/domain/booking-policy.js";
import { makePreview, makeSlot, makeTarget } from "./fixtures.js";

describe("booking preview policy", () => {
  it("allows an exact preview within all authorizations", () => {
    expect(
      evaluateBookingPreview(
        makeTarget(),
        makeSlot(),
        makePreview({
          prepaidRequired: true,
          prepaidAmountCents: 10_000,
          cancellationFeeCents: 5_000,
          noShowFeeCents: 5_000,
        }),
      ),
    ).toEqual({ allowed: true });
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
      makePreview({ prepaidRequired: true, prepaidAmountCents: 100 }),
    );

    expect(result).toEqual({
      allowed: false,
      reasons: [PolicyRejectionReason.UNEXPECTED_PREPAID_REQUIREMENT],
    });
  });

  it("rejects prepaid and fee exposure over their authorized limits", () => {
    const result = evaluateBookingPreview(
      makeTarget(),
      makeSlot(),
      makePreview({
        prepaidRequired: true,
        prepaidAmountCents: 10_001,
        cancellationFeeCents: 5_001,
      }),
    );

    expect(result).toEqual({
      allowed: false,
      reasons: [
        PolicyRejectionReason.PREPAID_AMOUNT_EXCEEDS_AUTHORIZATION,
        PolicyRejectionReason.CANCELLATION_EXPOSURE_EXCEEDS_AUTHORIZATION,
      ],
    });
  });

  it("fails closed on ambiguous, 3DS, unexpected seating, or date mismatch", () => {
    const result = evaluateBookingPreview(
      makeTarget(),
      makeSlot(),
      makePreview({
        isAmbiguous: true,
        requiresStrongCustomerAuthentication: true,
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
