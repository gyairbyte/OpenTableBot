import type {
  DetailedAvailability,
  ObservedAvailabilitySlot,
} from "../domain/availability-detail.js";
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

/** An observed open time that dining-area discovery fills in as it learns more. */
export type ObservationRecord = ObservedAvailabilitySlot & {
  diningAreas: string[];
  diningAreaIssue?: string | undefined;
};

/** A time-level slot that has not had its exact dining area established yet. */
export interface DiscoverableSlot {
  /** Has a browser preview reference but no exact dining area. */
  readonly slot: ReservationSlot;
  /** This time's entry in the observed list; discovery records areas or why it was skipped. */
  readonly observation: ObservationRecord;
}

export interface BaseAvailability {
  /** Times that passed every check except dining-area policy, in provider order. */
  readonly candidates: readonly DiscoverableSlot[];
  /** Every open time the lookup saw, including rejected ones. */
  readonly observedSlots: readonly ObservedAvailabilitySlot[];
}

export interface DiningAreaDiscovery {
  /** Exact, policy-acceptable slots for one time; empty when it was skipped. */
  readonly slots: readonly ReservationSlot[];
  /** Set when this one time could not establish an exact dining area. */
  readonly skippedReason?: string;
}

/**
 * Optional capability: look up open times first and establish dining areas one
 * time at a time. A booking run can then start on the best time without waiting
 * for every other time's dining-area lookup.
 */
export interface LazyDiningAreaDiscovery {
  findBaseSlots(target: BookingTarget): Promise<BaseAvailability>;
  discoverDiningAreas(
    target: BookingTarget,
    candidate: DiscoverableSlot,
  ): Promise<DiningAreaDiscovery>;
}

export function supportsLazyDiscovery<T extends OpenTableReadAdapter>(
  adapter: T,
): adapter is T & LazyDiningAreaDiscovery {
  const candidate = adapter as Partial<LazyDiningAreaDiscovery>;
  return (
    typeof candidate.findBaseSlots === "function" &&
    typeof candidate.discoverDiningAreas === "function"
  );
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
