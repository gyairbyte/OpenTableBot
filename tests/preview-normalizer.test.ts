import { describe, expect, it } from "vitest";
import { evaluateBookingPreview, PolicyRejectionReason } from "../src/domain/booking-policy.js";
import type { ReservationSlot } from "../src/domain/reservation-slot.js";
import { normalizeBookingPreview } from "../src/opentable/browser/preview-normalizer.js";
import type { GetBookingPreviewResult } from "../src/opentable/bridge/protocol.js";
import { makeSlot, makeTarget } from "./fixtures.js";

function result(
  overrides: Partial<GetBookingPreviewResult["data"]> = {},
  slot: ReservationSlot = makeSlot(),
): GetBookingPreviewResult {
  return {
    protocolVersion: 1,
    id: "preview-response",
    type: "GET_BOOKING_PREVIEW_RESULT",
    request: {
      slotId: slot.id,
      previewReference: slot.previewReference!,
      restaurantId: slot.restaurantId,
      date: slot.localDate,
      time: slot.localTime,
      partySize: slot.partySize,
      seatingType: slot.seatingType,
      reservationKind:
        slot.reservationKind.kind === "experience"
          ? {
              kind: "experience",
              experienceId: slot.reservationKind.experienceId,
            }
          : slot.reservationKind,
    },
    data: {
      restaurantId: slot.restaurantId,
      restaurantName: "Example Restaurant",
      reservationDateTime: `${slot.localDate}T${slot.localTime}`,
      partySize: slot.partySize,
      seatingType: slot.seatingType === "standard" ? "default" : slot.seatingType,
      reservationType: "Standard",
      creditCardRequired: false,
      currencyCode: "USD",
      diningArea: { id: 10, tableCategory: "default" },
      ...overrides,
    },
  };
}

describe("read-only booking preview normalization", () => {
  it("normalizes an ordinary Standard reservation with no fees", () => {
    const preview = normalizeBookingPreview(result(), makeTarget(), makeSlot());
    expect(preview).toMatchObject({
      reservationKind: { kind: "standard" },
      prepaid: { status: "not-required" },
      cancellationFee: { status: "none" },
      noShowFee: { status: "none" },
      paymentRequirement: "not-required",
      strongAuthentication: "not-required",
    });
  });

  it("normalizes a known per-party cancellation fee", () => {
    const preview = normalizeBookingPreview(
      result({
        creditCardRequired: true,
        strongAuthenticationRequired: false,
        cancellationMessage: "Cancellations within 24 hours incur a $30 charge.",
      }),
      makeTarget(),
      makeSlot(),
    );
    expect(preview.cancellationFee).toMatchObject({ status: "known", amountCents: 3_000 });
  });

  it("normalizes a known per-person no-show fee for the full party", () => {
    const preview = normalizeBookingPreview(
      result({
        creditCardRequired: true,
        strongAuthenticationRequired: false,
        cancellationMessage: "No-shows incur a $25 per person fee.",
      }),
      makeTarget(),
      makeSlot(),
    );
    expect(preview.noShowFee).toMatchObject({ status: "known", amountCents: 5_000 });
  });

  it("treats an explicit no-show-or-cancellation clause as alternative exposure", () => {
    const preview = normalizeBookingPreview(
      result({
        creditCardRequired: true,
        strongAuthenticationRequired: false,
        cancellationMessage:
          "No-shows or cancellations less than 24 hours in advance incur a $25 per person fee.",
      }),
      makeTarget(),
      makeSlot(),
    );
    expect(preview.cancellationFee).toMatchObject({
      status: "known",
      amountCents: 5_000,
    });
    expect(preview.noShowFee).toMatchObject({ status: "known", amountCents: 5_000 });
  });

  it("does not assume combined penalties are alternative without explicit wording", () => {
    const preview = normalizeBookingPreview(
      result({
        creditCardRequired: true,
        cancellationMessage: "No-show and cancellation penalties are $25 per person.",
      }),
      makeTarget(),
      makeSlot(),
    );
    expect(preview.cancellationFee.status).toBe("unknown");
    expect(preview.noShowFee.status).toBe("unknown");
  });

  it("keeps unquantified cancellation terms unknown", () => {
    const preview = normalizeBookingPreview(
      result({ creditCardRequired: true, cancellationMessage: "Cancellation terms apply." }),
      makeTarget(),
      makeSlot(),
    );
    expect(preview.cancellationFee.status).toBe("unknown");
  });

  it("keeps unquantified no-show terms unknown", () => {
    const preview = normalizeBookingPreview(
      result({ creditCardRequired: true, cancellationMessage: "No-show penalties apply." }),
      makeTarget(),
      makeSlot(),
    );
    expect(preview.noShowFee.status).toBe("unknown");
  });

  it("normalizes a known prepaid deposit", () => {
    const preview = normalizeBookingPreview(
      result({
        creditCardRequired: true,
        creditCardPolicyType: "Deposit",
        depositMessage: "A $20 per person deposit is required.",
      }),
      makeTarget(),
      makeSlot(),
    );
    expect(preview.prepaid).toMatchObject({ status: "required-known", amountCents: 4_000 });
  });

  it("fails closed when a prepaid amount is unknown", () => {
    const preview = normalizeBookingPreview(
      result({ creditCardRequired: true, creditCardPolicyType: "Deposit" }),
      makeTarget(),
      makeSlot(),
    );
    expect(preview.prepaid.status).toBe("required-unknown");
  });

  it("rejects a prepaid amount over the target limit", () => {
    const slot = makeSlot();
    const target = makeTarget({
      bookingPolicy: { ...makeTarget().bookingPolicy, maxAuthorizedPrepaidCents: 1_000 },
    });
    const preview = normalizeBookingPreview(
      result({
        creditCardRequired: true,
        creditCardPolicyType: "Deposit",
        depositMessage: "A $20 per person deposit is required.",
      }),
      target,
      slot,
    );
    expect(evaluateBookingPreview(target, slot, preview)).toMatchObject({
      allowed: false,
      reasons: expect.arrayContaining([
        PolicyRejectionReason.PREPAID_AMOUNT_EXCEEDS_AUTHORIZATION,
      ]),
    });
  });

  it("normalizes a selected Experience explicitly", () => {
    const slot = makeSlot({
      reservationKind: { kind: "experience", experienceId: "514735" },
    });
    const preview = normalizeBookingPreview(
      result(
        {
          reservationType: "Experience",
          experience: {
            id: 514735,
            name: "Community Table Dining",
            type: "PRIX_FIXE",
            summary: "Shared table experience.",
          },
        },
        slot,
      ),
      makeTarget(),
      slot,
    );
    expect(preview.reservationKind).toEqual({
      kind: "experience",
      experienceId: "514735",
      name: "Community Table Dining",
      type: "PRIX_FIXE",
      summary: "Shared table experience.",
    });
  });

  it("rejects an Experience when the target does not authorize Experiences", () => {
    const slot = makeSlot({
      reservationKind: { kind: "experience", experienceId: "514735" },
    });
    const preview = normalizeBookingPreview(
      result(
        {
          reservationType: "Experience",
          experience: { id: 514735, name: "Community Table Dining" },
        },
        slot,
      ),
      makeTarget(),
      slot,
    );
    expect(evaluateBookingPreview(makeTarget(), slot, preview)).toMatchObject({
      allowed: false,
      reasons: expect.arrayContaining([PolicyRejectionReason.EXPERIENCE_NOT_AUTHORIZED]),
    });
  });

  it("normalizes a payment-method requirement without exposing a card", () => {
    const preview = normalizeBookingPreview(
      result({ creditCardRequired: true, strongAuthenticationRequired: false }),
      makeTarget(),
      makeSlot(),
    );
    expect(preview.paymentRequirement).toBe("required");
  });

  it("normalizes and rejects an observed 3DS/SCA requirement", () => {
    const preview = normalizeBookingPreview(
      result({ creditCardRequired: true, strongAuthenticationRequired: true }),
      makeTarget(),
      makeSlot(),
    );
    expect(preview.strongAuthentication).toBe("required");
    expect(evaluateBookingPreview(makeTarget(), makeSlot(), preview)).toMatchObject({
      allowed: false,
      reasons: expect.arrayContaining([
        PolicyRejectionReason.STRONG_CUSTOMER_AUTHENTICATION_REQUIRED,
      ]),
    });
  });

  it.each([
    ["restaurant", { restaurantId: "wrong" }, /restaurant/iu],
    ["date", { reservationDateTime: "2026-09-02T19:00" }, /date/iu],
    ["time", { reservationDateTime: "2026-09-01T19:30" }, /time/iu],
    ["party size", { partySize: 4 }, /party size/iu],
    ["seating", { seatingType: "outdoor" }, /seating/iu],
  ])("fails closed for the wrong %s", (_label, override, expected) => {
    expect(() =>
      normalizeBookingPreview(result(override), makeTarget(), makeSlot()),
    ).toThrow(expected);
  });

  it("represents an unobserved currency as unknown", () => {
    const preview = normalizeBookingPreview(
      result({ currencyCode: undefined }),
      makeTarget(),
      makeSlot(),
    );
    expect(preview.currency).toEqual({ status: "unknown" });
  });

  it("rejects a malformed preview response", () => {
    const malformed = { ...result(), data: { restaurantId: "restaurant-123" } };
    expect(() =>
      normalizeBookingPreview(malformed as GetBookingPreviewResult, makeTarget(), makeSlot()),
    ).toThrow(/malformed booking preview response/iu);
  });

  it("authorizes the fully known happy path", () => {
    const slot = makeSlot();
    const target = makeTarget();
    const preview = normalizeBookingPreview(result(), target, slot);
    expect(evaluateBookingPreview(target, slot, preview)).toEqual({ allowed: true });
  });

  it("returns deterministic policy rejection reasons", () => {
    const slot = makeSlot();
    const target = makeTarget({
      bookingPolicy: {
        ...makeTarget().bookingPolicy,
        autoBookAuthorized: false,
        allowPaymentMethodRequired: false,
      },
    });
    const preview = normalizeBookingPreview(
      result({ creditCardRequired: true }),
      target,
      slot,
    );
    const first = evaluateBookingPreview(target, slot, preview);
    const second = evaluateBookingPreview(target, slot, preview);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      allowed: false,
      reasons: [
        PolicyRejectionReason.AUTO_BOOK_NOT_AUTHORIZED,
        PolicyRejectionReason.PAYMENT_METHOD_REQUIRED_NOT_AUTHORIZED,
        PolicyRejectionReason.STRONG_CUSTOMER_AUTHENTICATION_UNKNOWN,
        PolicyRejectionReason.CANCELLATION_FEE_UNKNOWN,
        PolicyRejectionReason.NO_SHOW_FEE_UNKNOWN,
      ],
    });
  });
});
