export const RECONNECT_ALARM_NAME = "opentablebot-bridge-reconnect";
export const RECONNECT_ALARM_PERIOD_MINUTES = 0.5;
export const RECONNECT_DELAY_MS = 1_500;

interface ReconnectSchedulerOptions {
  hasCredential: () => boolean;
  connect: () => void;
  setTimeout: (callback: () => void, delayMs: number) => number;
  ensureAlarm: () => void;
}

export interface ReconnectScheduler {
  ensureAlarm(): void;
  schedule(): void;
  handleAlarm(name: string): void;
}

/**
 * Keep the quick retry and the MV3 wake-up fallback separate. The timer gives
 * a fast retry while the worker is alive; the repeating alarm can wake a
 * suspended worker after the timer has been discarded.
 */
export function createReconnectScheduler(
  options: ReconnectSchedulerOptions,
): ReconnectScheduler {
  let reconnectTimer: number | undefined;

  function ensureAlarm(): void {
    if (options.hasCredential()) options.ensureAlarm();
  }

  function schedule(): void {
    if (!options.hasCredential() || reconnectTimer !== undefined) return;
    ensureAlarm();
    reconnectTimer = options.setTimeout(() => {
      reconnectTimer = undefined;
      options.connect();
    }, RECONNECT_DELAY_MS);
  }

  function handleAlarm(name: string): void {
    if (name !== RECONNECT_ALARM_NAME) return;
    ensureAlarm();
    if (options.hasCredential()) options.connect();
  }

  return { ensureAlarm, schedule, handleAlarm };
}
