import { describe, expect, it, vi } from "vitest";
import {
  createReconnectScheduler,
  RECONNECT_ALARM_NAME,
  RECONNECT_ALARM_PERIOD_MINUTES,
  RECONNECT_DELAY_MS,
} from "../extension/src/reconnect.js";

describe("extension reconnect scheduler", () => {
  it("uses a quick retry while also installing the durable alarm fallback", () => {
    let timerCallback: (() => void) | undefined;
    const connect = vi.fn();
    const ensureAlarm = vi.fn();
    const scheduler = createReconnectScheduler({
      hasCredential: () => true,
      connect,
      setTimeout: (callback, delayMs) => {
        expect(delayMs).toBe(RECONNECT_DELAY_MS);
        timerCallback = callback;
        return 1;
      },
      ensureAlarm,
    });

    scheduler.schedule();
    scheduler.schedule();

    expect(ensureAlarm).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();
    expect(timerCallback).toBeDefined();
    timerCallback!();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("reconnects when the alarm wakes a worker after its timer was lost", () => {
    const connect = vi.fn();
    const ensureAlarm = vi.fn();
    const scheduler = createReconnectScheduler({
      hasCredential: () => true,
      connect,
      setTimeout: () => 1,
      ensureAlarm,
    });

    scheduler.handleAlarm("unrelated-alarm");
    expect(connect).not.toHaveBeenCalled();
    scheduler.handleAlarm(RECONNECT_ALARM_NAME);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(ensureAlarm).toHaveBeenCalledTimes(1);
  });

  it("does not create alarms or connect without a paired credential", () => {
    const connect = vi.fn();
    const ensureAlarm = vi.fn();
    const scheduler = createReconnectScheduler({
      hasCredential: () => false,
      connect,
      setTimeout: () => 1,
      ensureAlarm,
    });

    scheduler.ensureAlarm();
    scheduler.schedule();
    scheduler.handleAlarm(RECONNECT_ALARM_NAME);

    expect(ensureAlarm).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("uses a Chrome-compatible repeating alarm period", () => {
    expect(RECONNECT_ALARM_PERIOD_MINUTES).toBe(0.5);
  });
});
