import { describe, expect, it } from "vitest";
import { PolicyRejectionReason } from "../src/domain/booking-policy.js";
import { validatePreparedBooking } from "../src/runner/booking-engine.js";
import type { PreparedBooking } from "../src/opentable/adapter.js";
import { makePreview, makeSlot, makeTarget } from "./fixtures.js";

describe("prepared booking validation", () => {
  it("evaluates only the normalized preview and does not expose the handle", () => {
    const preparedBooking: PreparedBooking = {
      preview: makePreview({ cancellationFee: { status: "unknown" } }),
      bookingHandle: "sensitive-ephemeral-handle",
      expiresAt: "2026-09-01T22:59:00Z",
    };

    const result = validatePreparedBooking(
      makeTarget(),
      makeSlot(),
      preparedBooking,
    );

    expect(result).toEqual({
      allowed: false,
      reasons: [PolicyRejectionReason.CANCELLATION_FEE_UNKNOWN],
    });
    expect(JSON.stringify(result)).not.toContain(preparedBooking.bookingHandle);
  });
});
