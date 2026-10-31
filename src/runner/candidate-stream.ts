import type { BookingTarget } from "../domain/booking-target.js";
import type { ReservationSlot } from "../domain/reservation-slot.js";
import { rankAcceptableSlots, rankBaseSlots } from "../domain/slot-matcher.js";
import type {
  BaseAvailability,
  DiscoverableSlot,
  LazyDiningAreaDiscovery,
} from "../opentable/adapter.js";
import { AdapterFailureCategory, OpenTableAdapterError } from "../opentable/errors.js";

export interface CandidateStats {
  /** Acceptable, dining-area-verified slots established so far. */
  readonly acceptable: number;
  /** Of those, the ones at the exact preferred time. */
  readonly preferred: number;
}

/**
 * Bookable slots in the order a run should try them: best first, one at a time.
 * A run books the first and only asks for the next if that one is gone, so the
 * work of establishing a later time's dining area happens only when needed.
 */
export interface CandidateStream {
  next(): Promise<ReservationSlot | undefined>;
  stats(): CandidateStats;
  /** Marks times that were never looked up so the run detail does not misread them. */
  finish(): void;
}

export interface CandidateStreamOptions {
  /** A known drop without acceptAnyTimeInWindow books only the preferred time. */
  readonly preferredOnly: boolean;
}

const NOT_CHECKED_NOTE = "Not checked: a better time was tried first";

/** Candidates that already carry exact dining areas, ranked best first. */
export function eagerCandidateStream(
  target: BookingTarget,
  slots: readonly ReservationSlot[],
  options: CandidateStreamOptions,
): CandidateStream {
  const preferred = slots.filter(
    (slot) => slot.localTime === target.timeWindow.preferred,
  );
  const queue = [
    ...rankAcceptableSlots(target, options.preferredOnly ? preferred : slots),
  ];
  return {
    next: async () => queue.shift(),
    stats: () => ({ acceptable: slots.length, preferred: preferred.length }),
    finish: () => undefined,
  };
}

/**
 * Candidates whose dining areas are established lazily, one time at a time in
 * rank order. Slots offered at the same time are looked up together, ranked by
 * the target's dining-area preference, and tried before the next time is
 * touched.
 */
export function lazyCandidateStream(
  adapter: LazyDiningAreaDiscovery,
  target: BookingTarget,
  base: BaseAvailability,
  options: CandidateStreamOptions,
): CandidateStream {
  const bySlot = new Map(base.candidates.map((candidate) => [candidate.slot, candidate]));
  const ordered: DiscoverableSlot[] = [];
  for (const slot of rankBaseSlots(
    target,
    base.candidates.map((candidate) => candidate.slot),
  )) {
    const candidate = bySlot.get(slot);
    if (candidate === undefined) continue;
    if (options.preferredOnly && slot.localTime !== target.timeWindow.preferred) continue;
    ordered.push(candidate);
  }
  const groups: DiscoverableSlot[][] = [];
  for (const candidate of ordered) {
    const key = `${candidate.slot.localDate}|${candidate.slot.localTime}`;
    const last = groups[groups.length - 1];
    if (last !== undefined && `${last[0]?.slot.localDate}|${last[0]?.slot.localTime}` === key) {
      last.push(candidate);
    } else {
      groups.push([candidate]);
    }
  }

  const queue: ReservationSlot[] = [];
  let nextGroup = 0;
  let acceptable = 0;
  let preferred = 0;
  let discovered = 0;
  const skipped: string[] = [];
  let checkedAllSkipped = false;

  const discoverNextGroup = async (): Promise<void> => {
    const group = groups[nextGroup];
    nextGroup += 1;
    if (group === undefined) return;
    const found: ReservationSlot[] = [];
    for (const candidate of group) {
      const discovery = await adapter.discoverDiningAreas(target, candidate);
      if (discovery.skippedReason !== undefined) {
        skipped.push(discovery.skippedReason);
        continue;
      }
      discovered += 1;
      found.push(...discovery.slots);
    }
    const ranked = rankAcceptableSlots(target, [
      ...new Map(found.map((slot) => [slot.id, slot])).values(),
    ]);
    acceptable += ranked.length;
    preferred += ranked.filter(
      (slot) => slot.localTime === target.timeWindow.preferred,
    ).length;
    queue.push(...ranked);
  };

  return {
    next: async () => {
      while (queue.length === 0 && nextGroup < groups.length) {
        await discoverNextGroup();
      }
      if (
        queue.length === 0 &&
        !checkedAllSkipped &&
        skipped.length > 0 &&
        discovered === 0
      ) {
        // Skipping tolerates a few odd times. When every time that reached
        // discovery was skipped the problem is systematic, so fail closed and say
        // why rather than letting it look like "no availability".
        checkedAllSkipped = true;
        throw new OpenTableAdapterError(
          AdapterFailureCategory.UNEXPECTED_RESPONSE,
          `Dining-area discovery failed for all ${skipped.length} slot(s); first: ${skipped[0]}`,
        );
      }
      return queue.shift();
    },
    stats: () => ({ acceptable, preferred }),
    finish: () => {
      if (options.preferredOnly) return;
      for (const group of groups.slice(nextGroup)) {
        for (const { observation } of group) {
          if (observation.diningAreaIssue === undefined && observation.diningAreas.length === 0) {
            observation.diningAreaIssue = NOT_CHECKED_NOTE;
          }
        }
      }
    },
  };
}
