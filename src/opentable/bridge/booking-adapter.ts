import type { BookingTarget } from "../../domain/booking-target.js";
import { evaluateBookingPreview } from "../../domain/booking-policy.js";
import type { BookingPreview, ReservationSlot } from "../../domain/reservation-slot.js";
import type {
  AuthenticationStatus,
  BookingSubmissionResult,
  OpenTableBookingAdapter,
  PreparedBooking,
  RestaurantSearchQuery,
} from "../adapter.js";
import { AdapterFailureCategory, OpenTableAdapterError } from "../errors.js";
import { normalizeBookingPreview } from "../browser/preview-normalizer.js";
import type { SafeSearchResults } from "../browser/search-types.js";
import type {
  AuthorizeBookingResult,
  BookingIntent,
  GetBookingPreviewResult,
  LockSlotResult,
  SubmitReservationResult,
  AcknowledgeLockResult,
  RevalidatePreparedBookingResult,
} from "./protocol.js";
import {
  BrowserBridgeOpenTableReadAdapter,
  mapBridgeError,
  type BrowserBridgeReadAdapterOptions,
  type OpenTableBridgeClientPort,
} from "./read-adapter.js";

export interface OpenTableBookingBridgeClientPort extends OpenTableBridgeClientPort {
  authorizeBooking(request: BookingIntent): Promise<AuthorizeBookingResult>;
  lockSlot(authorizationHandle: string, request: BookingIntent): Promise<LockSlotResult>;
  acknowledgeLock(operationId: string, preparedHandle: string): Promise<AcknowledgeLockResult>;
  revalidatePreparedBooking(preparedHandle: string, request: BookingIntent): Promise<RevalidatePreparedBookingResult>;
  submitReservation(preparedHandle: string, request: BookingIntent): Promise<SubmitReservationResult>;
}

function intentFor(
  target: BookingTarget,
  slot: ReservationSlot,
  approvedPreview: BookingPreview,
): BookingIntent {
  if (slot.previewReference === undefined) {
    throw new OpenTableAdapterError(
      AdapterFailureCategory.INVARIANT_MISMATCH,
      "Selected slot has no current browser preview reference",
    );
  }
  if (slot.diningArea === undefined || approvedPreview.diningArea === undefined) {
    throw new OpenTableAdapterError(
      AdapterFailureCategory.INVARIANT_MISMATCH,
      "Controlled booking requires exact dining-area evidence",
    );
  }
  if (slot.reservationKind.kind !== "standard") {
    throw new OpenTableAdapterError(
      AdapterFailureCategory.POLICY_REJECTED,
      "Phase 3 controlled booking supports Standard reservations only",
    );
  }
  const policy = evaluateBookingPreview(target, slot, approvedPreview);
  if (!policy.allowed) {
    throw new OpenTableAdapterError(
      AdapterFailureCategory.POLICY_REJECTED,
      `Booking policy rejected the approved preview: ${policy.reasons.join(", ")}`,
    );
  }
  return {
    targetId: target.id,
    slotId: slot.id,
    previewReference: slot.previewReference,
    restaurantId: target.restaurant.id,
    date: slot.localDate,
    time: slot.localTime,
    startsAt: slot.startsAt,
    partySize: target.partySize,
    seatingType: slot.seatingType,
    diningArea: slot.diningArea,
    reservationKind: { kind: "standard" },
    approvedPreview,
  };
}

function samePreview(left: BookingPreview, right: BookingPreview): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class BrowserBridgeOpenTableBookingAdapter implements OpenTableBookingAdapter {
  private readonly read: BrowserBridgeOpenTableReadAdapter;
  private readonly preparedIntents = new Map<string, BookingIntent>();
  private readonly observedPreviews = new Map<string, BookingPreview>();
  private readonly bookingAuthorizations = new Set<string>();

  constructor(
    private readonly client: OpenTableBookingBridgeClientPort,
    options: BrowserBridgeReadAdapterOptions = {},
  ) {
    this.read = new BrowserBridgeOpenTableReadAdapter(client, options);
  }

  start(): Promise<void> { return this.read.start(); }
  close(): Promise<void> { return this.read.close(); }
  checkAuthentication(): Promise<AuthenticationStatus> { return this.read.checkAuthentication(); }
  findSlots(target: BookingTarget): Promise<readonly ReservationSlot[]> { return this.read.findSlots(target); }
  searchRestaurants(query: RestaurantSearchQuery): Promise<SafeSearchResults> {
    return this.read.searchRestaurants(query);
  }
  getBookingPreview(target: BookingTarget, slot: ReservationSlot): Promise<BookingPreview> {
    return this.read.getBookingPreview(target, slot).then((preview) => {
      if (slot.previewReference !== undefined) {
        this.observedPreviews.set(slot.previewReference, preview);
      }
      return preview;
    });
  }

  private assertObservedPreview(slot: ReservationSlot, preview: BookingPreview): void {
    const observed = slot.previewReference === undefined
      ? undefined
      : this.observedPreviews.get(slot.previewReference);
    if (observed === undefined || !samePreview(observed, preview)) {
      throw new OpenTableAdapterError(
        AdapterFailureCategory.INVARIANT_MISMATCH,
        "Booking authorization requires the exact preview returned by this adapter",
      );
    }
  }

  async authorizeBooking(
    target: BookingTarget,
    slot: ReservationSlot,
    approvedPreview: BookingPreview,
  ): Promise<{ readonly authorizationHandle: string; readonly expiresAt: string }> {
    this.assertObservedPreview(slot, approvedPreview);
    try {
      const result = await this.client.authorizeBooking(intentFor(target, slot, approvedPreview));
      this.bookingAuthorizations.add(result.authorizationHandle);
      return { authorizationHandle: result.authorizationHandle, expiresAt: result.expiresAt };
    } catch (error) {
      mapBridgeError(error);
    }
  }

  async prepareBooking(
    target: BookingTarget,
    slot: ReservationSlot,
    approvedPreview: BookingPreview,
    authorizationHandle: string,
  ): Promise<PreparedBooking> {
    this.assertObservedPreview(slot, approvedPreview);
    if (!this.bookingAuthorizations.delete(authorizationHandle)) {
      throw new OpenTableAdapterError(
        AdapterFailureCategory.DUPLICATE_SUBMISSION_PREVENTED,
        "Booking authorization is invalid, stale, or already used for a lock attempt",
      );
    }
    const intent = intentFor(target, slot, approvedPreview);
    let result: LockSlotResult;
    try {
      result = await this.client.lockSlot(authorizationHandle, intent);
    } catch (error) {
      mapBridgeError(error);
    }
    if (result.outcome.status !== "LOCK_CONFIRMED") {
      const category = result.outcome.status === "LOCK_REJECTED"
        ? AdapterFailureCategory.LOCK_REJECTED
        : result.outcome.status === "LOCK_NOT_DISPATCHED"
          ? AdapterFailureCategory.LOCK_NOT_DISPATCHED
          : AdapterFailureCategory.LOCK_OUTCOME_UNKNOWN;
      throw new OpenTableAdapterError(category, result.outcome.message);
    }
    const confirmed = result.outcome;
    let revalidated: RevalidatePreparedBookingResult;
    try {
      await this.client.acknowledgeLock(confirmed.operationId, confirmed.preparedHandle);
      revalidated = await this.client.revalidatePreparedBooking(confirmed.preparedHandle, intent);
    } catch (error) {
      mapBridgeError(error);
    }
    const normalizedPostLock = normalizeBookingPreview(
      {
        protocolVersion: result.protocolVersion,
        id: result.id,
        type: "GET_BOOKING_PREVIEW_RESULT",
        request: {
          slotId: intent.slotId,
          previewReference: intent.previewReference,
          restaurantId: intent.restaurantId,
          date: intent.date,
          time: intent.time,
          partySize: intent.partySize,
          seatingType: intent.seatingType,
          diningArea: intent.diningArea,
          reservationKind: intent.reservationKind,
        },
        data: revalidated.data,
      } satisfies GetBookingPreviewResult,
      target,
      slot,
    );
    const policy = evaluateBookingPreview(target, slot, normalizedPostLock);
    if (!policy.allowed || !samePreview(approvedPreview, normalizedPostLock)) {
      throw new OpenTableAdapterError(
        AdapterFailureCategory.TERMS_CHANGED,
        !policy.allowed
          ? `Post-lock policy rejected terms: ${policy.reasons.join(", ")}`
          : "Critical booking terms changed after the slot lock",
      );
    }
    this.preparedIntents.set(confirmed.preparedHandle, intent);
    return {
      preview: normalizedPostLock,
      bookingHandle: confirmed.preparedHandle,
      expiresAt: confirmed.expiresAt,
    };
  }

  async book(
    target: BookingTarget,
    slot: ReservationSlot,
    preparedBooking: PreparedBooking,
  ): Promise<BookingSubmissionResult> {
    const expiresAtMs = Date.parse(preparedBooking.expiresAt);
    if (Number.isNaN(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new OpenTableAdapterError(
        AdapterFailureCategory.LOCK_EXPIRED,
        Number.isNaN(expiresAtMs)
          ? "Prepared slot lock has an invalid expiry"
          : "Prepared slot lock expired",
      );
    }
    const intent = this.preparedIntents.get(preparedBooking.bookingHandle);
    if (intent === undefined) {
      throw new OpenTableAdapterError(
        AdapterFailureCategory.DUPLICATE_SUBMISSION_PREVENTED,
        "Prepared handle is invalid, stale, or already consumed",
      );
    }
    const expected = intentFor(target, slot, preparedBooking.preview);
    if (JSON.stringify(intent) !== JSON.stringify(expected)) {
      throw new OpenTableAdapterError(AdapterFailureCategory.INVARIANT_MISMATCH, "Prepared booking intent changed");
    }
    this.preparedIntents.delete(preparedBooking.bookingHandle);
    try {
      return (await this.client.submitReservation(preparedBooking.bookingHandle, intent)).result;
    } catch (error) {
      mapBridgeError(error);
    }
  }
}
