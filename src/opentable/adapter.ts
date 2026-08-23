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

/**
 * The only boundary allowed to know OpenTable request, browser, or response
 * details. Domain and orchestration code depend on this normalized contract.
 */
export interface OpenTableAdapter {
  start?(): Promise<void>;
  checkAuthentication(): Promise<AuthenticationStatus>;
  findSlots(target: BookingTarget): Promise<readonly ReservationSlot[]>;
  previewBooking(
    target: BookingTarget,
    slot: ReservationSlot,
  ): Promise<BookingPreview>;
  book(
    target: BookingTarget,
    slot: ReservationSlot,
    preview: BookingPreview,
  ): Promise<BookingConfirmation>;
  close?(): Promise<void>;
}
