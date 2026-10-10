import { describe, expect, it, vi } from "vitest";
import {
  type DiningAreaOption,
  type DiningAreaPolicy,
  isDiningAreaAllowed,
  normalizeDiningAreaCategory,
  rankDiningAreaOptions,
} from "../src/domain/dining-area.js";
import type { BookingTarget } from "../src/domain/booking-target.js";
import type {
  BookingPreview,
  ReservationSlot,
} from "../src/domain/reservation-slot.js";
import { rankAcceptableSlots } from "../src/domain/slot-matcher.js";
import { selectFirstAuthorizedCandidate } from "../src/runner/candidate-selection.js";
import { exactDiningAreas } from "../extension/src/main-world.js";
import { makePreview, makeSlot, makeTarget } from "./fixtures.js";

const ANY: DiningAreaPolicy = { mode: "any", selection: "provider-order" };

function area(
  category: DiningAreaOption["category"],
  label: string,
  providerOrder: number,
): DiningAreaOption {
  return { category, label, providerOrder };
}

function slotWithArea(
  id: string,
  diningArea: DiningAreaOption,
  overrides: Partial<ReservationSlot> = {},
): ReservationSlot {
  return makeSlot({
    id,
    diningArea,
    previewReference: `00000000-0000-4000-8000-${String(diningArea.providerOrder + 1).padStart(12, "0")}`,
    ...overrides,
  });
}

function targetWithPolicy(
  diningAreaPolicy: DiningAreaPolicy,
  overrides: Partial<BookingTarget> = {},
): BookingTarget {
  return {
    ...makeTarget(),
    allowedSeatingTypes: undefined,
    diningAreaPolicy,
    ...overrides,
  };
}

function previewFor(
  slot: ReservationSlot,
  overrides: Partial<BookingPreview> = {},
): BookingPreview {
  return makePreview({
    slotId: slot.id,
    localDate: slot.localDate,
    localTime: slot.localTime,
    partySize: slot.partySize,
    seatingType: slot.seatingType,
    diningArea: slot.diningArea,
    reservationKind: slot.reservationKind,
    ...overrides,
  });
}

function previewAdapter(
  implementation: (slot: ReservationSlot) => Promise<BookingPreview>,
) {
  return { getBookingPreview: vi.fn((_target: BookingTarget, slot: ReservationSlot) => implementation(slot)) };
}

describe("generalized dining-area candidates", () => {
  it("1. represents one time with one dining area", () => {
    const slot = slotWithArea("one", area("dining-room", "Dining Room", 0));
    expect(rankAcceptableSlots(targetWithPolicy(ANY), [slot])).toEqual([slot]);
  });

  it("2. preserves multiple Standard dining areas at one time", () => {
    const slots = [
      slotWithArea("room", area("dining-room", "Dining Room", 0)),
      slotWithArea("other", area("other", "Other", 1)),
    ];
    expect(rankAcceptableSlots(targetWithPolicy(ANY), slots)).toHaveLength(2);
  });

  it("3. ANY selects the first provider-ordered authorized area", async () => {
    const earlier = slotWithArea("room", area("dining-room", "Dining Room", 0));
    const later = slotWithArea("other", area("other", "Other", 1));
    const adapter = previewAdapter(async (slot) => previewFor(slot));
    const result = await selectFirstAuthorizedCandidate(adapter, targetWithPolicy(ANY), [later, earlier]);
    expect(result.selected?.slot.id).toBe("room");
  });

  it("4. advances when the first area's preview fails policy", async () => {
    const first = slotWithArea("first", area("dining-room", "Dining Room", 0));
    const second = slotWithArea("second", area("other", "Other", 1));
    const adapter = previewAdapter(async (slot) => previewFor(slot, slot.id === "first"
      ? { paymentRequirement: "required" }
      : {}));
    const result = await selectFirstAuthorizedCandidate(adapter, targetWithPolicy(ANY), [second, first]);
    expect(result.evaluations.map(({ status }) => status)).toEqual(["rejected", "authorized"]);
    expect(result.selected?.slot.id).toBe("second");
  });

  it("5. PREFER category outranks an earlier non-preferred area", () => {
    const policy: DiningAreaPolicy = {
      mode: "prefer",
      preferences: [{ type: "category", value: "rooftop" }],
      fallback: "any",
      selection: "provider-order",
    };
    const ranked = rankDiningAreaOptions(policy, [
      { diningArea: area("dining-room", "Dining Room", 0) },
      { diningArea: area("rooftop", "Roof", 1) },
    ]);
    expect(ranked[0]?.diningArea.label).toBe("Roof");
  });

  it("6. PREFER label matches the exact sanitized provider label", () => {
    const policy: DiningAreaPolicy = {
      mode: "prefer",
      preferences: [{ type: "label", value: "Sky Terrace" }],
      fallback: "any",
      selection: "provider-order",
    };
    const ranked = rankDiningAreaOptions(policy, [
      { diningArea: area("unknown", "Atrium", 0) },
      { diningArea: area("unknown", "Sky Terrace", 1) },
    ]);
    expect(ranked[0]?.diningArea.label).toBe("Sky Terrace");
  });

  it("7. PREFER falls back to ANY when configured", () => {
    const policy: DiningAreaPolicy = {
      mode: "prefer",
      preferences: [{ type: "category", value: "garden" }],
      fallback: "any",
      selection: "provider-order",
    };
    expect(rankDiningAreaOptions(policy, [{ diningArea: area("unknown", "Atrium", 2) }])).toHaveLength(1);
  });

  it("8. PREFER with fallback NONE rejects non-matches", () => {
    const policy: DiningAreaPolicy = {
      mode: "prefer",
      preferences: [{ type: "category", value: "garden" }],
      fallback: "none",
      selection: "provider-order",
    };
    expect(rankDiningAreaOptions(policy, [{ diningArea: area("unknown", "Atrium", 0) }])).toEqual([]);
  });

  it("9. ALLOW accepts configured categories only", () => {
    const policy: DiningAreaPolicy = {
      mode: "allow", categories: ["patio"], labels: [], selection: "provider-order",
    };
    expect(isDiningAreaAllowed(policy, area("patio", "Sidewalk", 0))).toBe(true);
    expect(isDiningAreaAllowed(policy, area("indoor", "Atrium", 1))).toBe(false);
  });

  it("10. ALLOW accepts exact provider labels", () => {
    const policy: DiningAreaPolicy = {
      mode: "allow", categories: [], labels: ["Pool Deck"], selection: "provider-order",
    };
    expect(isDiningAreaAllowed(policy, area("unknown", "Pool Deck", 0))).toBe(true);
    expect(isDiningAreaAllowed(policy, area("unknown", "pool deck", 1))).toBe(false);
  });

  it("11. accepts an unknown provider label under ANY", () => {
    expect(isDiningAreaAllowed(ANY, area("unknown", "Greenhouse", 0))).toBe(true);
  });

  it("12. rejects an unknown provider label outside an explicit allowlist", () => {
    const policy: DiningAreaPolicy = {
      mode: "allow", categories: ["outdoor"], labels: [], selection: "provider-order",
    };
    expect(isDiningAreaAllowed(policy, area("unknown", "Greenhouse", 0))).toBe(false);
  });

  it("13. keeps duplicate normalized categories with distinct identities distinct", () => {
    const candidates = exactDiningAreas({ timeSlot: { diningAreasBySeating: [
      { diningAreaId: 10, tableCategory: "default", name: "Main Hall" },
      { diningAreaId: 11, tableCategory: "default", name: "Fireplace Room" },
    ] } }, "default");
    expect(candidates.map(({ providerId }) => providerId)).toEqual([10, 11]);
    expect(candidates.map(({ option }) => option.label)).toEqual(["Main Hall", "Fireplace Room"]);
  });

  it("14. deduplicates a semantically identical provider identity", () => {
    const candidates = exactDiningAreas({ timeSlot: { diningAreasBySeating: [
      { diningAreaId: 10, tableCategory: "default", name: "Main Hall" },
      { diningAreaId: 10, tableCategory: "default", name: "Main Hall" },
    ] } }, "default");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.option.providerOrder).toBe(0);
  });

  it("15. fails closed for contradictory duplicate provider identity", () => {
    expect(() => exactDiningAreas({ timeSlot: { diningAreasBySeating: [
      { diningAreaId: 10, tableCategory: "default", name: "Main Hall" },
      { diningAreaId: 10, tableCategory: "default", name: "Fireplace Room" },
    ] } }, "default")).toThrow(/DINING_AREA_CONFLICT/u);
  });

  it("16. Standard-only policy excludes an Experience at the same time", () => {
    const standard = slotWithArea("standard", area("dining-room", "Dining Room", 1));
    const experience = slotWithArea("experience", area("terrace", "Terrace", 0), {
      reservationKind: { kind: "experience", experienceId: "exp-1" },
    });
    expect(rankAcceptableSlots(targetWithPolicy(ANY), [experience, standard]).map(({ id }) => id)).toEqual(["standard"]);
  });

  it("17. provider ordering is stable", () => {
    const slots = [2, 0, 1].map((order) => slotWithArea(`slot-${order}`, area("unknown", `Area ${order}`, order)));
    expect(rankAcceptableSlots(targetWithPolicy(ANY), slots).map(({ id }) => id)).toEqual(["slot-0", "slot-1", "slot-2"]);
  });

  it("18. object and map insertion order cannot change selection", () => {
    const byLabel = new Map([
      ["third", slotWithArea("third", area("unknown", "Third", 2))],
      ["first", slotWithArea("first", area("unknown", "First", 0))],
      ["second", slotWithArea("second", area("unknown", "Second", 1))],
    ]);
    expect(rankAcceptableSlots(targetWithPolicy(ANY), [...byLabel.values()])[0]?.id).toBe("first");
  });

  it("19. evaluates the opaque preview reference bound to each exact area", async () => {
    const first = slotWithArea("first", area("dining-room", "Dining Room", 0));
    const second = slotWithArea("second", area("other", "Other", 1));
    const observedReferences: string[] = [];
    const adapter = previewAdapter(async (slot) => {
      observedReferences.push(slot.previewReference!);
      return previewFor(slot, slot.id === "first" ? { paymentRequirement: "required" } : {});
    });
    await selectFirstAuthorizedCandidate(adapter, targetWithPolicy(ANY), [second, first]);
    expect(observedReferences).toEqual([first.previewReference, second.previewReference]);
  });

  it("20. cannot substitute another area during preview", async () => {
    const first = slotWithArea("first", area("dining-room", "Dining Room", 0));
    const second = slotWithArea("second", area("other", "Other", 1));
    const adapter = previewAdapter(async (slot) => {
      if (slot.id === "first") throw new Error("Preview dining area did not match its browser-local identity");
      return previewFor(slot);
    });
    const result = await selectFirstAuthorizedCandidate(adapter, targetWithPolicy(ANY), [first, second]);
    expect(result.evaluations[0]?.status).toBe("preview-failed");
    expect(result.selected?.slot.id).toBe("second");
  });

  it("21. returns a sanitized provider-evidenced label to Node", () => {
    const candidates = exactDiningAreas({ timeSlot: { diningAreasBySeating: [
      { diningAreaId: 44, tableCategory: "default", displayName: "  Pool\n Deck  " },
    ] } }, "default");
    expect(candidates[0]?.option).toMatchObject({
      category: "unknown",
      label: "Pool Deck",
      providerOrder: 0,
    });
    expect(normalizeDiningAreaCategory("Pool Deck")).toBe("unknown");
  });

  it("resolves a display label from another provider record with the same browser-local identity", () => {
    const candidates = exactDiningAreas({
      timeSlot: {
        diningAreasBySeating: [
          { diningAreaId: 44, tableCategory: "default" },
          { diningAreaId: 45, tableCategory: "default" },
        ],
      },
      diningAreaDetails: [
        { diningAreaId: 44, displayLabel: "Dining Room" },
        { diningAreaId: 45, displayLabel: "Sky Terrace" },
      ],
    }, "default");
    expect(candidates.map(({ option }) => option.label)).toEqual(["Dining Room", "Sky Terrace"]);
  });

  it("fails closed when linked records conflict on a provider display label", () => {
    expect(() => exactDiningAreas({
      timeSlot: { diningAreasBySeating: [{ diningAreaId: 44, tableCategory: "default" }] },
      diningAreaDetails: [
        { diningAreaId: 44, label: "Dining Room" },
        { diningAreaId: 44, displayName: "Sky Terrace" },
      ],
    }, "default")).toThrow(/DINING_AREA_CONFLICT/u);
  });

  it("22. performs no write operation during candidate selection", async () => {
    const lockSlot = vi.fn();
    const submitReservation = vi.fn();
    const candidate = slotWithArea("one", area("dining-room", "Dining Room", 0));
    const adapter = {
      getBookingPreview: vi.fn(async () => previewFor(candidate)),
      lockSlot,
      submitReservation,
    };
    const result = await selectFirstAuthorizedCandidate(adapter, targetWithPolicy(ANY), [candidate]);
    expect(result.selected?.slot.id).toBe("one");
    expect(lockSlot).not.toHaveBeenCalled();
    expect(submitReservation).not.toHaveBeenCalled();
  });
});
