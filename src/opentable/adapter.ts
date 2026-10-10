import type { DetailedAvailability } from "../domain/availability-detail.js";
import type { BookingTarget } from "../domain/booking-target.js";
import type {
  BookingConfirmation,
  BookingPreview,
  ReservationSlot,
} from "../domain/reservation-slot.js";
import type { SafeSearchResults } from "./browser/search-types.js";

/** Provider-neutral restaurant search query. */
export interface RestaurantSearchQuery {
  readonly term: string;
  readonly date?: string | undefined;
  readonly time?: string | undefined;
  readonly partySize?: number | undefined;
}

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
  readonly expiresAt: string;
}

export type BookingSubmissionResult =
  | { readonly status: "confirmed"; readonly confirmation: BookingConfirmation }
  | { readonly status: "outcome-unknown"; readonly message: string };

/**
 * The only boundary allowed to know OpenTable request, browser, or response
 * details. Domain and orchestration code depend on this normalized contract.
 */
/** Read-only operations implemented by the Phase 1 browser adapter. */
export interface OpenTableReadAdapter {
  start?(): Promise<void>;
  checkAuthentication(): Promise<AuthenticationStatus>;
  findSlots(target: BookingTarget): Promise<readonly ReservationSlot[]>;
  /**
   * The same lookup as findSlots, plus every open time the page offered even
   * when the target rejects it (for example times outside the configured
   * window). Used for diagnostic run detail; never for slot selection.
   */
  findSlotsDetailed(
    target: BookingTarget,
  ): Promise<DetailedAvailability>;
  /** Read booking terms without preparing, holding, or locking inventory. */
  getBookingPreview(
    target: BookingTarget,
    slot: ReservationSlot,
  ): Promise<BookingPreview>;
  /** Search restaurants through the paired browser session, when supported. */
  searchRestaurants?(query: RestaurantSearchQuery): Promise<SafeSearchResults>;
  close?(): Promise<void>;
}

/** Future write-capable adapter. Phase 1 does not implement this interface. */
export interface OpenTableBookingAdapter extends OpenTableReadAdapter {
  authorizeBooking(
    target: BookingTarget,
    slot: ReservationSlot,
    approvedPreview: BookingPreview,
  ): Promise<{ readonly authorizationHandle: string; readonly expiresAt: string }>;
  prepareBooking(
    target: BookingTarget,
    slot: ReservationSlot,
    approvedPreview: BookingPreview,
    authorizationHandle: string,
  ): Promise<PreparedBooking>;
  book(
    target: BookingTarget,
    slot: ReservationSlot,
    preparedBooking: PreparedBooking,
  ): Promise<BookingSubmissionResult>;
}

/** Backwards-compatible name for the complete booking-capable contract. */
export type OpenTableAdapter = OpenTableBookingAdapter;
