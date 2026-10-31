import { describe, expect, it } from "vitest";
import {
  getSlotRejectionReasons,
  isSlotAcceptable,
  rankAcceptableSlots,
  rankBaseSlots,
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
      getSlotRejectionReasons(makeTarget(), makeSlot({
        seatingType: "bar",
        diningArea: { category: "bar", label: "Bar", providerOrder: 0 },
      })),
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
      makeSlot({
        id: "z-outdoor",
        seatingType: "outdoor",
        diningArea: { category: "outdoor", label: "Patio", providerOrder: 1 },
      }),
      makeSlot({ id: "z-standard", seatingType: "standard" }),
      makeSlot({ id: "a-standard", seatingType: "standard" }),
    ]);

    expect(ranked.map(({ id }) => id)).toEqual([
      "a-standard",
      "z-standard",
      "z-outdoor",
    ]);
  });

  it("prefers a Standard table over Bar and Counter at the same time when areas are indistinguishable", () => {
    // Momofuku-style response: every seating reports the same "Other" area, so
    // only the seating type separates the candidates. Ids are chosen so the
    // old hash-style tie-break would have picked the bar seat.
    const other = { category: "other", label: "Other", providerOrder: 0 } as const;
    const ranked = rankAcceptableSlots(makeTarget({ diningAreaPolicy: { mode: "any", selection: "provider-order" } }), [
      makeSlot({ id: "a-bar", seatingType: "bar", diningArea: other }),
      makeSlot({ id: "b-counter", seatingType: "counter", diningArea: other }),
      makeSlot({ id: "c-standard", seatingType: "standard", diningArea: other }),
    ]);

    expect(ranked.map(({ id }) => id)).toEqual(["c-standard", "a-bar", "b-counter"]);
  });

  it("lets an explicit dining-area preference outrank the Standard tie-break", () => {
    const ranked = rankAcceptableSlots(
      makeTarget({
        diningAreaPolicy: {
          mode: "prefer",
          preferences: [{ type: "category", value: "bar" }],
          fallback: "any",
          selection: "provider-order",
        },
      }),
      [
        makeSlot({ id: "a-standard", seatingType: "standard" }),
        makeSlot({
          id: "z-bar",
          seatingType: "bar",
          diningArea: { category: "bar", label: "Bar", providerOrder: 0 },
        }),
      ],
    );

    expect(ranked.map(({ id }) => id)).toEqual(["z-bar", "a-standard"]);
  });

  it("never lets the Standard tie-break override time distance", () => {
    const ranked = rankAcceptableSlots(makeTarget(), [
      makeSlot({ id: "standard-far", seatingType: "standard", localTime: "19:30" }),
      makeSlot({ id: "bar-near", seatingType: "bar", localTime: "19:15" }),
    ]);

    expect(ranked.map(({ id }) => id)).toEqual(["bar-near", "standard-far"]);
  });
});

describe("rankBaseSlots", () => {
  it("orders time-level slots by distance from the preferred time without filtering", () => {
    const ranked = rankBaseSlots(makeTarget(), [
      makeSlot({ id: "far", localTime: "20:00" }),
      makeSlot({ id: "exact", localTime: "19:00" }),
      makeSlot({ id: "outside-window", localTime: "23:00" }),
      makeSlot({ id: "near", localTime: "19:15" }),
    ]);

    expect(ranked.map(({ id }) => id)).toEqual(["exact", "near", "far", "outside-window"]);
  });

  it("breaks a distance tie by the earlier time, then Standard seating, then id", () => {
    const ranked = rankBaseSlots(makeTarget(), [
      makeSlot({ id: "after", localTime: "19:15" }),
      makeSlot({ id: "before", localTime: "18:45" }),
      makeSlot({ id: "z-bar", seatingType: "bar", localTime: "19:30" }),
      makeSlot({ id: "a-standard", seatingType: "standard", localTime: "19:30" }),
    ]);

    expect(ranked.map(({ id }) => id)).toEqual(["before", "after", "a-standard", "z-bar"]);
  });
});
