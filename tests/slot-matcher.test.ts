import { describe, expect, it } from "vitest";
import {
  getSlotRejectionReasons,
  isSlotAcceptable,
  rankAcceptableSlots,
  SlotRejectionReason,
} from "../src/domain/slot-matcher.js";
import { makeSlot, makeTarget } from "./fixtures.js";

describe("slot matching", () => {
  it.each([
    ["2026-08-31", "19:00"],
    ["2026-09-02", "19:00"],
    ["2026-09-01", "17:59"],
    ["2026-09-01", "20:01"],
  ])("rejects a slot outside the date/time window (%s %s)", (date, time) => {
    expect(isSlotAcceptable(makeTarget(), makeSlot({ localDate: date, localTime: time }))).toBe(false);
  });

  it("reports date and time rejection reasons independently", () => {
    expect(
      getSlotRejectionReasons(
        makeTarget(),
        makeSlot({ localDate: "2026-09-02", localTime: "20:01" }),
      ),
    ).toEqual([
      SlotRejectionReason.DATE_OUTSIDE_RANGE,
      SlotRejectionReason.TIME_OUTSIDE_WINDOW,
    ]);
  });

  it("accepts window boundaries", () => {
    expect(isSlotAcceptable(makeTarget(), makeSlot({ localTime: "18:00" }))).toBe(true);
    expect(isSlotAcceptable(makeTarget(), makeSlot({ localTime: "20:00" }))).toBe(true);
  });

  it("rejects disallowed seating", () => {
    expect(
      getSlotRejectionReasons(makeTarget(), makeSlot({ seatingType: "bar" })),
    ).toContain(SlotRejectionReason.SEATING_NOT_ALLOWED);
  });
});

describe("slot ranking", () => {
  it("ranks acceptable slots by distance from preferred time", () => {
    const ranked = rankAcceptableSlots(makeTarget(), [
      makeSlot({ id: "far", localTime: "18:00" }),
      makeSlot({ id: "best", localTime: "19:15" }),
      makeSlot({ id: "middle", localTime: "19:30" }),
      makeSlot({ id: "rejected", localTime: "21:00" }),
    ]);

    expect(ranked.map(({ id }) => id)).toEqual(["best", "middle", "far"]);
  });

  it("uses earlier time as a deterministic equal-distance tie-breaker", () => {
    const ranked = rankAcceptableSlots(makeTarget(), [
      makeSlot({ id: "later", localTime: "19:30" }),
      makeSlot({ id: "earlier", localTime: "18:30" }),
    ]);

    expect(ranked.map(({ id }) => id)).toEqual(["earlier", "later"]);
  });

  it("then uses seating preference and stable ID", () => {
    const ranked = rankAcceptableSlots(makeTarget(), [
      makeSlot({ id: "z-outdoor", seatingType: "outdoor" }),
      makeSlot({ id: "z-standard", seatingType: "standard" }),
      makeSlot({ id: "a-standard", seatingType: "standard" }),
    ]);

    expect(ranked.map(({ id }) => id)).toEqual([
      "a-standard",
      "z-standard",
      "z-outdoor",
    ]);
  });
});
