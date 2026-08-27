import type { BookingTarget } from "../domain/booking-target.js";
import type { PolicyEvaluation } from "../domain/booking-policy.js";
import type {
  BookingPreview,
  ReservationSlot,
} from "../domain/reservation-slot.js";
import { rankAcceptableSlots } from "../domain/slot-matcher.js";
import type { OpenTableReadAdapter } from "../opentable/adapter.js";
import { validateBookingPreview } from "./booking-engine.js";

export type CandidateEvaluation =
  | {
      readonly slot: ReservationSlot;
      readonly status: "authorized" | "rejected";
      readonly preview: BookingPreview;
      readonly policy: PolicyEvaluation;
    }
  | {
      readonly slot: ReservationSlot;
      readonly status: "preview-failed";
      readonly error: string;
    };

export interface CandidateSelectionResult {
  readonly selected?: {
    readonly slot: ReservationSlot;
    readonly preview: BookingPreview;
  };
  readonly evaluations: readonly CandidateEvaluation[];
}

/**
 * Evaluates candidates in deterministic time/dining-area order using read-only
 * previews. It never authorizes, locks, prepares, or submits a reservation.
 */
export async function selectFirstAuthorizedCandidate(
  adapter: Pick<OpenTableReadAdapter, "getBookingPreview">,
  target: BookingTarget,
  candidates: readonly ReservationSlot[],
): Promise<CandidateSelectionResult> {
  const evaluations: CandidateEvaluation[] = [];
  for (const slot of rankAcceptableSlots(target, candidates)) {
    let preview: BookingPreview;
    try {
      preview = await adapter.getBookingPreview(target, slot);
    } catch (error) {
      evaluations.push({
        slot,
        status: "preview-failed",
        error: error instanceof Error ? error.message : "Unknown preview failure",
      });
      continue;
    }
    const policy = validateBookingPreview(target, slot, preview);
    if (!policy.allowed) {
      evaluations.push({ slot, status: "rejected", preview, policy });
      continue;
    }
    evaluations.push({ slot, status: "authorized", preview, policy });
    return { selected: { slot, preview }, evaluations };
  }
  return { evaluations };
}
