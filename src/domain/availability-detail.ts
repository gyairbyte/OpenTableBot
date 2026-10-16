import { z } from "zod";
import type { ReservationSlot } from "./reservation-slot.js";
import { LocalDateSchema, LocalTimeSchema, SeatingTypeSchema } from "./primitives.js";
import { SlotRejectionReason } from "./slot-matcher.js";

/**
 * One time the restaurant actually offered during an availability lookup, kept
 * even when the target rejects it. This is the evidence behind a no-match pause:
 * the operator can see every open time, including the ones outside the
 * configured earliest/latest window, instead of only "0 slot(s) were returned".
 */
export interface ObservedAvailabilitySlot {
  readonly localDate: string;
  readonly localTime: string;
  readonly seatingType: string;
  readonly reservationKind: "standard" | "experience" | "unknown";
  /** True when the time falls inside the target's earliest/latest window. */
  readonly withinWindow: boolean;
  /** Why the target would reject this time, excluding dining-area policy. */
  readonly rejectionReasons: readonly SlotRejectionReason[];
  /** Dining-area labels the adapter confirmed acceptable for this time. */
  readonly diningAreas: readonly string[];
  /**
   * Set when dining-area discovery could not establish an exact area for this
   * time, so it was skipped and never offered for booking. Carries the
   * sanitized provider-facing reason.
   */
  readonly diningAreaIssue?: string | undefined;
}

export const ObservedAvailabilitySlotSchema = z.strictObject({
  localDate: LocalDateSchema,
  localTime: LocalTimeSchema,
  seatingType: SeatingTypeSchema,
  reservationKind: z.enum(["standard", "experience", "unknown"]),
  withinWindow: z.boolean(),
  rejectionReasons: z.enum(
    Object.values(SlotRejectionReason) as [
      SlotRejectionReason,
      ...SlotRejectionReason[],
    ],
  ).array(),
  diningAreas: z.string().min(1).max(120).array(),
  diningAreaIssue: z.string().min(1).max(300).optional(),
});

/** One availability lookup, with timing and everything it observed. */
export interface AvailabilityAttempt {
  /** ISO instant the lookup started. */
  readonly startedAt: string;
  readonly durationMs: number;
  /** Slots the adapter returned after policy filtering. */
  readonly acceptableSlots: number;
  /** Acceptable slots at the exact preferred time. */
  readonly preferredSlots: number;
  /** Every open time seen, accepted or not. */
  readonly observedSlots: readonly ObservedAvailabilitySlot[];
}

export const AvailabilityAttemptSchema = z.strictObject({
  startedAt: z.string().datetime({ offset: true }),
  durationMs: z.number().int().nonnegative(),
  acceptableSlots: z.number().int().nonnegative(),
  preferredSlots: z.number().int().nonnegative(),
  observedSlots: ObservedAvailabilitySlotSchema.array(),
});

/**
 * Structured availability evidence for one engine run, stored on the target
 * record so the console can show it after a pause, or after a cancellation
 * watcher's latest poll. It is diagnostic data only: it never influences slot
 * selection, booking, or retries.
 */
export interface AvailabilityRunDetail {
  readonly preferredTime: string;
  readonly earliest: string;
  readonly latest: string;
  /**
   * Whether the final attempt produced a bookable candidate: the exact
   * preferred time for a known drop, or any acceptable time inside the window
   * for a cancellation watch.
   */
  readonly matched: boolean;
  readonly capturedAt: string;
  readonly attempts: readonly AvailabilityAttempt[];
}

export const AvailabilityRunDetailSchema = z.strictObject({
  preferredTime: LocalTimeSchema,
  earliest: LocalTimeSchema,
  latest: LocalTimeSchema,
  matched: z.boolean(),
  capturedAt: z.string().datetime({ offset: true }),
  attempts: AvailabilityAttemptSchema.array().min(1),
});

/** What a detailed availability lookup returns to the engine. */
export interface DetailedAvailability {
  /** Today's findSlots result: acceptable, dining-area-verified slots. */
  readonly acceptableSlots: readonly ReservationSlot[];
  /** Every open time the lookup saw, including rejected ones. */
  readonly observedSlots: readonly ObservedAvailabilitySlot[];
}
