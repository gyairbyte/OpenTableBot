import type { BookingConfirmation } from "../domain/reservation-slot.js";
import type { TargetState } from "../domain/target-state.js";

export type Notification =
  | {
      readonly type: "booking-confirmed";
      readonly targetId: string;
      readonly confirmation: BookingConfirmation;
    }
  | {
      readonly type: "target-paused";
      readonly targetId: string;
      readonly reason: string;
    }
  | {
      /** A watcher has been unable to scan for longer than the alert threshold. */
      readonly type: "watcher-blind";
      readonly targetId: string;
      readonly reason: string;
      readonly blindForMs: number;
    }
  | {
      readonly type: "watcher-recovered";
      readonly targetId: string;
      readonly blindForMs: number;
    }
  | {
      readonly type: "state-changed";
      readonly targetId: string;
      readonly from: TargetState;
      readonly to: TargetState;
    };

export interface Notifier {
  notify(event: Notification): Promise<void>;
}
