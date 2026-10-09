import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LocalNotifier,
  notificationLogPath,
} from "../src/notifications/local-notifier.js";

describe("LocalNotifier", () => {
  it("prints and appends each notification as JSON lines", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "otb-log-"));
    const lines: string[] = [];
    const notifier = new LocalNotifier({
      directory,
      write: (line) => lines.push(line),
      now: () => new Date("2026-10-01T12:00:00.000Z"),
    });

    await notifier.notify({
      type: "target-paused",
      targetId: "target-1",
      reason: "challenge",
    });
    await notifier.notify({
      type: "booking-confirmed",
      targetId: "target-1",
      confirmation: {
        confirmationId: "confirmation-1",
        slotId: "slot-1",
        restaurantId: "restaurant-123",
        startsAt: "2026-09-01T19:00:00-04:00",
        partySize: 2,
        seatingType: "standard",
        bookedAt: "2026-08-26T12:00:00.000Z",
      },
    });

    expect(lines).toHaveLength(2);
    const log = await readFile(notificationLogPath(directory), "utf8");
    const entries = log
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.timestamp).toBe("2026-10-01T12:00:00.000Z");
    expect(entries[0]?.type).toBe("target-paused");
    expect(entries[1]?.type).toBe("booking-confirmed");
  });
});
