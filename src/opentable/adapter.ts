import type { BookingTarget } from "../domain/booking-target.js";
import type {
  BookingConfirmation,
  BookingPreview,
  ReservationSlot,
} from "../domain/reservation-slot.js";

export type AuthenticationStatus =
  | { readonly authenticated: true }
  | {
      readonly authenticated: false;
      readonly reason: "required" | "expired";
    };

export interface PreparedBooking {
  readonly preview: BookingPreview;

  /**
   * Opaque adapter-owned, ephemeral handle for the prepared/held booking
   * context. Domain code must never interpret it. It is potentially sensitive
   * and must remain in memory only: never persisted, logged, included in a
   * notification, or exposed to a user.
   */
  readonly bookingHandle: string;

  /** Provider-supplied expiry of the prepared context, when available. */
  readonly expiresAt?: string;
}

/**
 * The only boundary allowed to know OpenTable request, browser, or response
 * details. Domain and orchestration code depend on this normalized contract.
 */
/** Read-only operations implemented by the Phase 1 browser adapter. */
export interface OpenTableReadAdapter {
  start?(): Promise<void>;
  checkAuthentication(): Promise<AuthenticationStatus>;
  findSlots(target: BookingTarget): Promise<readonly ReservationSlot[]>;
  /** Read booking terms without preparing, holding, or locking inventory. */
  getBookingPreview(
    target: BookingTarget,
    slot: ReservationSlot,
  ): Promise<BookingPreview>;
  close?(): Promise<void>;
}

/** Future write-capable adapter. Phase 1 does not implement this interface. */
export interface OpenTableBookingAdapter extends OpenTableReadAdapter {
  prepareBooking(
    target: BookingTarget,
    slot: ReservationSlot,
  ): Promise<PreparedBooking>;
  book(
    target: BookingTarget,
    slot: ReservationSlot,
    preparedBooking: PreparedBooking,
  ): Promise<BookingConfirmation>;
}

/** Backwards-compatible name for the complete booking-capable contract. */
export type OpenTableAdapter = OpenTableBookingAdapter;
