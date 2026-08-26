import { describe, expect, it } from "vitest";
import {
  BRIDGE_PROTOCOL_VERSION,
  BridgeMessageSchema,
  FindSlotsResultSchema,
  GetBookingPreviewResultSchema,
  OpenTablePageUrlSchema,
  sanitizeOpenTablePageUrl,
} from "../src/opentable/bridge/protocol.js";

describe("bridge protocol", () => {
  it("rejects unknown fields and unsupported versions", () => {
    const message = {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      id: "message-id",
      deadlineEpochMs: Date.now() + 1_000,
      type: "PING",
      arbitraryOperation: "book",
    };
    expect(BridgeMessageSchema.safeParse(message).success).toBe(false);
    expect(BridgeMessageSchema.safeParse({ ...message, arbitraryOperation: undefined, protocolVersion: 2 }).success).toBe(false);
    expect(
      BridgeMessageSchema.safeParse({
        protocolVersion: 1,
        id: "booking-request",
        deadlineEpochMs: Date.now() + 1_000,
        type: "BOOK",
      }).success,
    ).toBe(false);
  });

  it("allows only the canonical HTTPS OpenTable origin", () => {
    expect(OpenTablePageUrlSchema.safeParse("https://www.opentable.com/r/example").success).toBe(true);
    expect(OpenTablePageUrlSchema.safeParse("https://opentable.com/r/example").success).toBe(false);
    expect(OpenTablePageUrlSchema.safeParse("https://www.opentable.com.evil.test/").success).toBe(false);
    expect(OpenTablePageUrlSchema.safeParse("http://www.opentable.com/").success).toBe(false);
  });

  it("removes query and fragment state before page URLs leave Chrome", () => {
    expect(
      sanitizeOpenTablePageUrl(
        "https://www.opentable.com/r/don-angie-new-york?avt=opaque-token&p=2#booking",
      ),
    ).toBe("https://www.opentable.com/r/don-angie-new-york");
  });

  it("rejects sensitive or unrecognized availability fields", () => {
    const result = {
      protocolVersion: 1,
      id: "response-id",
      type: "FIND_SLOTS_RESULT",
      request: { restaurantId: "1", date: "2026-09-01", time: "19:00", partySize: 2, databaseRegion: "NA" },
      data: {
        availability: [{ restaurantId: "1", availabilityDays: [{ dayOffset: 0, slots: [{ isAvailable: true, slotHash: "secret" }] }] }],
      },
    };
    expect(FindSlotsResultSchema.safeParse(result).success).toBe(false);
  });

  it("rejects sensitive or unrecognized booking-preview fields", () => {
    const result = {
      protocolVersion: 1,
      id: "preview-response",
      type: "GET_BOOKING_PREVIEW_RESULT",
      request: {
        slotId: "slot-1",
        previewReference: "00000000-0000-4000-8000-000000000001",
        restaurantId: "1",
        date: "2026-09-01",
        time: "19:00",
        partySize: 2,
        seatingType: "standard",
        reservationKind: { kind: "standard" },
      },
      data: {
        restaurantId: "1",
        reservationDateTime: "2026-09-01T19:00",
        partySize: 2,
        seatingType: "default",
        savedCardId: "must-not-cross",
      },
    };
    expect(GetBookingPreviewResultSchema.safeParse(result).success).toBe(false);
  });

  it("has no lock, prepare, payment, or reservation-submission message", () => {
    for (const type of [
      "LOCK_SLOT",
      "PREPARE_RESERVATION",
      "MAKE_RESERVATION",
      "SUBMIT_PAYMENT",
      "BOOK",
    ]) {
      expect(
        BridgeMessageSchema.safeParse({
          protocolVersion: 1,
          id: "forbidden-message",
          deadlineEpochMs: Date.now() + 1_000,
          type,
        }).success,
      ).toBe(false);
    }
  });
});
