import type { AvailabilityRunDetail } from "../domain/availability-detail.js";
import type { BookingTarget } from "../domain/booking-target.js";
import type { BookingConfirmation } from "../domain/reservation-slot.js";
import type { TargetState } from "../domain/target-state.js";

export interface TargetRecord {
  readonly target: BookingTarget;
  readonly state: TargetState;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pauseReason?: string | undefined;
  readonly confirmation?: BookingConfirmation | undefined;
  /**
   * Availability evidence from the most recent engine run that reached an
   * availability lookup, kept so the console can explain a pause with every
   * open time the run saw. Cleared at the start of each run (the explicit
   * undefined is how the engine removes the key on its first save).
   */
  readonly availabilityDetail?: AvailabilityRunDetail | undefined;
  /**
   * Why the most recent watcher run could not scan (for example the browser
   * page was not ready) while the watcher stayed armed. Cleared at the start
   * of each run, so its presence after a run means that run was blind.
   */
  readonly scanBlockedReason?: string | undefined;
}

export interface TargetStore {
  get(targetId: string): Promise<TargetRecord | undefined>;
  save(record: TargetRecord, expectedVersion: number): Promise<TargetRecord>;
  listRunnable(): Promise<readonly TargetRecord[]>;
}

/**
 * A target store that also supports version-checked removal, for operators
 * that manage the task list interactively.
 */
export interface RemovableTargetStore extends TargetStore {
  remove(targetId: string, expectedVersion: number): Promise<void>;
}
