import { describe, expect, it } from "vitest";
import { windowsTaskScope } from "../src/platform/windows-scheduled-task.js";
import { makeTarget } from "./fixtures.js";

const RELEASE = "2026-10-31T09:00:00-04:00";

function drop(id: string, overrides: Parameters<typeof makeTarget>[0] = {}) {
  return makeTarget({ id, knownReservationReleaseAt: RELEASE, ...overrides });
}

describe("windowsTaskScope", () => {
  it("binds a lone target to its own task", () => {
    const lunch = drop("lunch");

    const scope = windowsTaskScope(lunch, [lunch]);

    expect(scope).toEqual({
      taskName: "OpenTableBot-lunch",
      targetId: "lunch",
      groupedTargetIds: undefined,
    });
  });

  it("shares one task between targets that fire together at one restaurant", () => {
    const lunch = drop("lunch");
    const dinner = drop("dinner");

    const scope = windowsTaskScope(lunch, [lunch, dinner]);

    expect(scope.targetId).toBeUndefined();
    expect(scope.groupedTargetIds).toEqual(["dinner", "lunch"]);
    expect(scope.taskName).toBe("OpenTableBot-restaurant-123-20261031T130000000Z");
  });

  it("gives the same task name whichever target registers it", () => {
    const lunch = drop("lunch");
    const dinner = drop("dinner");

    const fromLunch = windowsTaskScope(lunch, [lunch, dinner]);
    const fromDinner = windowsTaskScope(dinner, [lunch, dinner]);

    expect(fromDinner.taskName).toBe(fromLunch.taskName);
    expect(fromDinner.groupedTargetIds).toEqual(fromLunch.groupedTargetIds);
  });

  it("treats the same instant written with another offset as the same release", () => {
    const lunch = drop("lunch");
    const dinner = drop("dinner", { knownReservationReleaseAt: "2026-10-31T13:00:00Z" });

    expect(windowsTaskScope(lunch, [dinner]).targetId).toBeUndefined();
  });

  it("keeps targets with a different release time on separate tasks", () => {
    const lunch = drop("lunch");
    const later = drop("later", { knownReservationReleaseAt: "2026-10-31T09:05:00-04:00" });

    expect(windowsTaskScope(lunch, [later]).targetId).toBe("lunch");
  });

  it("keeps targets at a different restaurant on separate tasks", () => {
    const lunch = drop("lunch");
    const elsewhere = drop("elsewhere", {
      restaurant: { id: "other-999", name: "Elsewhere", timeZone: "America/New_York" },
    });

    expect(windowsTaskScope(lunch, [elsewhere]).targetId).toBe("lunch");
  });

  it("ignores cancellation watchers that happen to carry a release time", () => {
    const lunch = drop("lunch");
    const watcher = drop("watcher", { mode: "cancellation-watch" });

    expect(windowsTaskScope(lunch, [watcher]).targetId).toBe("lunch");
  });
});
