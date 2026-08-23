import type { BookingTarget } from "../domain/booking-target.js";
import type { BookingConfirmation } from "../domain/reservation-slot.js";
import type { TargetState } from "../domain/target-state.js";

export interface TargetRecord {
  readonly target: BookingTarget;
  readonly state: TargetState;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pauseReason?: string;
  readonly confirmation?: BookingConfirmation;
}

export interface TargetStore {
  get(targetId: string): Promise<TargetRecord | undefined>;
  save(record: TargetRecord, expectedVersion: number): Promise<TargetRecord>;
  listRunnable(): Promise<readonly TargetRecord[]>;
}
