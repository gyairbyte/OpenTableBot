import { describe, expect, it, vi } from "vitest";
import type { AuthenticationStatus } from "../src/opentable/adapter.js";
import { BrowserBridgeOpenTableBookingAdapter, type OpenTableBookingBridgeClientPort } from "../src/opentable/bridge/booking-adapter.js";
import type { AcknowledgeLockResult, AuthorizeBookingResult, BookingIntent, FindSlotsResult, GetBookingPreviewResult, LockSlotResult, RevalidatePreparedBookingResult, SubmitReservationResult } from "../src/opentable/bridge/protocol.js";
import { makePreview, makeSlot, makeTarget } from "./fixtures.js";
import { BridgeClientError } from "../src/opentable/bridge/client.js";

function safePostLock(overrides: Record<string, unknown> = {}) {
  return {
    restaurantId: "restaurant-123",
    reservationDateTime: "2026-09-01T19:00",
    partySize: 2,
    seatingType: "default",
    reservationType: "Standard",
    creditCardRequired: false,
    currencyCode: "USD",
    strongAuthenticationRequired: false,
    diningArea: {
      category: "dining-room" as const,
      label: "Dining Room",
      providerOrder: 0,
    },
    ...overrides,
  };
}

function clientFixture(postLockOverrides: Record<string, unknown> = {}) {
  const client: OpenTableBookingBridgeClientPort = {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    authenticationStatus: vi.fn<() => Promise<AuthenticationStatus>>().mockResolvedValue({ authenticated: true }),
    findSlots: vi.fn<() => Promise<FindSlotsResult>>(),
    listDiningAreas: vi.fn(),
    searchRestaurants: vi.fn(),
    getBookingPreview: vi.fn<() => Promise<GetBookingPreviewResult>>().mockResolvedValue({
      protocolVersion: 1,
      id: "preview-result",
      type: "GET_BOOKING_PREVIEW_RESULT",
      request: {
        slotId: "slot-1",
        previewReference: "00000000-0000-4000-8000-000000000001",
        restaurantId: "restaurant-123",
        date: "2026-09-01",
        time: "19:00",
        partySize: 2,
        seatingType: "standard",
        diningArea: {
          category: "dining-room",
          label: "Dining Room",
          providerOrder: 0,
        },
        reservationKind: { kind: "standard" },
      },
      data: safePostLock(),
    }),
    authorizeBooking: vi.fn<(request: BookingIntent) => Promise<AuthorizeBookingResult>>().mockImplementation(async () => ({
      protocolVersion: 1,
      id: "authorize-result",
      type: "AUTHORIZE_BOOKING_RESULT",
      authorizationHandle: "00000000-0000-4000-8000-000000000009",
      expiresAt: "2099-01-01T00:00:00.000Z",
    })),
    lockSlot: vi.fn<(handle: string, request: BookingIntent) => Promise<LockSlotResult>>().mockResolvedValue({
      protocolVersion: 1,
      id: "lock-result",
      type: "LOCK_SLOT_RESULT",
      outcome: {
        status: "LOCK_CONFIRMED",
        operationId: "lock-operation-1",
        preparedHandle: "00000000-0000-4000-8000-000000000010",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    }),
    acknowledgeLock: vi.fn<(operationId: string, handle: string) => Promise<AcknowledgeLockResult>>().mockResolvedValue({
      protocolVersion: 1,
      id: "ack-result",
      type: "ACKNOWLEDGE_LOCK_RESULT",
      acknowledged: true,
    }),
    revalidatePreparedBooking: vi.fn<(handle: string, request: BookingIntent) => Promise<RevalidatePreparedBookingResult>>().mockImplementation(async (handle, request) => ({
      protocolVersion: 1,
      id: "revalidate-result",
      type: "REVALIDATE_PREPARED_BOOKING_RESULT",
      preparedHandle: handle,
      request,
      data: safePostLock(postLockOverrides),
    })),
    submitReservation: vi.fn<(handle: string, request: BookingIntent) => Promise<SubmitReservationResult>>().mockResolvedValue({
      protocolVersion: 1,
      id: "submit-result",
      type: "SUBMIT_RESERVATION_RESULT",
      result: {
        status: "confirmed",
        confirmation: {
          confirmationId: "ABC123",
          slotId: "slot-1",
          restaurantId: "restaurant-123",
          startsAt: "2026-09-01T19:00:00-04:00",
          partySize: 2,
          seatingType: "standard",
          bookedAt: "2026-08-26T12:00:00.000Z",
        },
      },
    }),
  };
  return client;
}

describe("browser booking adapter", () => {
  async function observe(adapter: BrowserBridgeOpenTableBookingAdapter) {
    return adapter.getBookingPreview(makeTarget(), makeSlot());
  }

  async function authorize(adapter: BrowserBridgeOpenTableBookingAdapter) {
    const preview = await observe(adapter);
    const authorization = await adapter.authorizeBooking(makeTarget(), makeSlot(), preview);
    return { preview, handle: authorization.authorizationHandle };
  }

  it("returns PreparedBooking only after a valid lock and post-lock preview", async () => {
    const adapter = new BrowserBridgeOpenTableBookingAdapter(clientFixture());
    const { preview, handle } = await authorize(adapter);
    const prepared = await adapter.prepareBooking(
      makeTarget(), makeSlot(), preview, handle,
    );
    expect(prepared.bookingHandle).toBe("00000000-0000-4000-8000-000000000010");
    expect(prepared.preview).toEqual(makePreview());
  });

  it("fails closed when SCA appears after lock", async () => {
    const adapter = new BrowserBridgeOpenTableBookingAdapter(clientFixture({ strongAuthenticationRequired: true }));
    const { preview, handle } = await authorize(adapter);
    await expect(adapter.prepareBooking(
      makeTarget(), makeSlot(), preview, handle,
    )).rejects.toThrow("Post-lock policy rejected");
  });

  it("maps a definitive lock rejection without preparing a handle", async () => {
    const client = clientFixture();
    vi.mocked(client.lockSlot).mockRejectedValueOnce(new BridgeClientError("LOCK_REJECTED", "slot lost"));
    const adapter = new BrowserBridgeOpenTableBookingAdapter(client);
    const { preview, handle } = await authorize(adapter);
    await expect(adapter.prepareBooking(
      makeTarget(), makeSlot(), preview, handle,
    )).rejects.toMatchObject({ category: "LOCK_REJECTED" });
  });

  it("returns a typed provider lock rejection", async () => {
    const client = clientFixture();
    vi.mocked(client.lockSlot).mockResolvedValueOnce({
      protocolVersion: 1,
      id: "lock-result",
      type: "LOCK_SLOT_RESULT",
      outcome: { status: "LOCK_REJECTED", message: "slot lost" },
    });
    const adapter = new BrowserBridgeOpenTableBookingAdapter(client);
    const { preview, handle } = await authorize(adapter);
    await expect(adapter.prepareBooking(makeTarget(), makeSlot(), preview, handle)).rejects.toMatchObject({ category: "LOCK_REJECTED" });
    expect(client.submitReservation).not.toHaveBeenCalled();
  });

  it("does not issue a duplicate lock after LOCK_OUTCOME_UNKNOWN", async () => {
    const client = clientFixture();
    vi.mocked(client.lockSlot).mockResolvedValueOnce({
      protocolVersion: 1,
      id: "lock-result",
      type: "LOCK_SLOT_RESULT",
      outcome: { status: "LOCK_OUTCOME_UNKNOWN", message: "dispatched; outcome unknown" },
    });
    const adapter = new BrowserBridgeOpenTableBookingAdapter(client);
    const { preview, handle } = await authorize(adapter);
    await expect(adapter.prepareBooking(makeTarget(), makeSlot(), preview, handle)).rejects.toMatchObject({ category: "LOCK_OUTCOME_UNKNOWN" });
    await expect(adapter.prepareBooking(makeTarget(), makeSlot(), preview, handle)).rejects.toThrow("already used");
    expect(client.lockSlot).toHaveBeenCalledTimes(1);
    expect(client.submitReservation).not.toHaveBeenCalled();
  });

  it("keeps confirmed lock distinct when revalidation times out", async () => {
    const client = clientFixture();
    vi.mocked(client.revalidatePreparedBooking).mockRejectedValueOnce(
      new BridgeClientError("REVALIDATION_OUTCOME_UNKNOWN", "revalidation timed out"),
    );
    const adapter = new BrowserBridgeOpenTableBookingAdapter(client);
    const { preview, handle } = await authorize(adapter);
    await expect(adapter.prepareBooking(makeTarget(), makeSlot(), preview, handle)).rejects.toMatchObject({ category: "REVALIDATION_OUTCOME_UNKNOWN" });
    expect(client.lockSlot).toHaveBeenCalledTimes(1);
    expect(client.acknowledgeLock).toHaveBeenCalledTimes(1);
    expect(client.submitReservation).not.toHaveBeenCalled();
  });

  it("rejects substituted preview terms before creating a capability", async () => {
    const client = clientFixture();
    const adapter = new BrowserBridgeOpenTableBookingAdapter(client);
    await observe(adapter);
    await expect(adapter.authorizeBooking(
      makeTarget(), makeSlot(), makePreview({ currency: { status: "unknown" } }),
    )).rejects.toThrow("exact preview");
    expect(client.authorizeBooking).not.toHaveBeenCalled();
  });

  it("submits a prepared handle once and prevents duplicate calls", async () => {
    const client = clientFixture();
    const adapter = new BrowserBridgeOpenTableBookingAdapter(client);
    const { preview, handle } = await authorize(adapter);
    const prepared = await adapter.prepareBooking(
      makeTarget(), makeSlot(), preview, handle,
    );
    const result = await adapter.book(makeTarget(), makeSlot(), prepared);
    expect(result.status).toBe("confirmed");
    await expect(adapter.book(makeTarget(), makeSlot(), prepared)).rejects.toThrow("already consumed");
    expect(client.submitReservation).toHaveBeenCalledTimes(1);
  });

  it("rejects an expired lock without a submission", async () => {
    const client = clientFixture();
    const adapter = new BrowserBridgeOpenTableBookingAdapter(client);
    await expect(adapter.book(makeTarget(), makeSlot(), {
      preview: makePreview(),
      bookingHandle: "00000000-0000-4000-8000-000000000010",
      expiresAt: "2000-01-01T00:00:00.000Z",
    })).rejects.toThrow("expired");
    expect(client.submitReservation).not.toHaveBeenCalled();
  });

  it("rejects an invalid expiry without a submission", async () => {
    const client = clientFixture();
    const adapter = new BrowserBridgeOpenTableBookingAdapter(client);
    await expect(adapter.book(makeTarget(), makeSlot(), {
      preview: makePreview(),
      bookingHandle: "00000000-0000-4000-8000-000000000010",
      expiresAt: "not-a-date",
    })).rejects.toMatchObject({ category: "LOCK_EXPIRED" });
    expect(client.submitReservation).not.toHaveBeenCalled();
  });

  it("preserves OUTCOME_UNKNOWN and performs no blind retry", async () => {
    const client = clientFixture();
    vi.mocked(client.submitReservation).mockResolvedValueOnce({
      protocolVersion: 1,
      id: "submit-result",
      type: "SUBMIT_RESERVATION_RESULT",
      result: { status: "outcome-unknown", message: "dispatched; do not retry" },
    });
    const adapter = new BrowserBridgeOpenTableBookingAdapter(client);
    const { preview, handle } = await authorize(adapter);
    const prepared = await adapter.prepareBooking(
      makeTarget(), makeSlot(), preview, handle,
    );
    expect((await adapter.book(makeTarget(), makeSlot(), prepared)).status).toBe("outcome-unknown");
    await expect(adapter.book(makeTarget(), makeSlot(), prepared)).rejects.toThrow("already consumed");
    expect(client.submitReservation).toHaveBeenCalledTimes(1);
  });

  it("does not retry a definitive submission rejection", async () => {
    const client = clientFixture();
    vi.mocked(client.submitReservation).mockRejectedValueOnce(
      new BridgeClientError("SUBMISSION_REJECTED", "provider rejected"),
    );
    const adapter = new BrowserBridgeOpenTableBookingAdapter(client);
    const { preview, handle } = await authorize(adapter);
    const prepared = await adapter.prepareBooking(
      makeTarget(), makeSlot(), preview, handle,
    );
    await expect(adapter.book(makeTarget(), makeSlot(), prepared)).rejects.toMatchObject({ category: "SUBMISSION_REJECTED" });
    await expect(adapter.book(makeTarget(), makeSlot(), prepared)).rejects.toThrow("already consumed");
    expect(client.submitReservation).toHaveBeenCalledTimes(1);
  });
});
