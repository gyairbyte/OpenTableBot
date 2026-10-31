import { describe, expect, it, vi } from "vitest";
import type {
  BaseAvailability,
  DiningAreaDiscovery,
  DiscoverableSlot,
  LazyDiningAreaDiscovery,
  ObservationRecord,
} from "../src/opentable/adapter.js";
import { AdapterFailureCategory } from "../src/opentable/errors.js";
import {
  eagerCandidateStream,
  lazyCandidateStream,
} from "../src/runner/candidate-stream.js";
import { makeSlot, makeTarget } from "./fixtures.js";

const target = makeTarget({
  timeWindow: { earliest: "12:00", latest: "14:00", preferred: "12:30" },
});

function candidateAt(time: string, id = `base-${time}`): DiscoverableSlot {
  const observation: ObservationRecord = {
    localDate: "2026-09-01",
    localTime: time,
    seatingType: "standard",
    reservationKind: "standard",
    withinWindow: true,
    rejectionReasons: [],
    diningAreas: [],
  };
  return { slot: makeSlot({ id, localTime: time }), observation };
}

function baseOf(...candidates: DiscoverableSlot[]): BaseAvailability {
  return {
    candidates,
    observedSlots: candidates.map((candidate) => candidate.observation),
  };
}

/** Discovery that returns one exact slot per base slot, in the order asked. */
function discovery(
  skip: ReadonlySet<string> = new Set(),
): { adapter: LazyDiningAreaDiscovery; asked: string[] } {
  const asked: string[] = [];
  const adapter: LazyDiningAreaDiscovery = {
    findBaseSlots: vi.fn(),
    discoverDiningAreas: vi.fn(
      async (
        _target,
        candidate: DiscoverableSlot,
      ): Promise<DiningAreaDiscovery> => {
        asked.push(candidate.slot.id);
        if (skip.has(candidate.slot.id)) {
          return { slots: [], skippedReason: `skipped ${candidate.slot.id}` };
        }
        candidate.observation.diningAreas.push("Dining Room");
        return {
          slots: [
            makeSlot({
              id: `exact-${candidate.slot.id}`,
              localTime: candidate.slot.localTime,
              diningArea: {
                category: "dining-room",
                label: "Dining Room",
                providerOrder: candidate.slot.diningArea?.providerOrder ?? 0,
              },
            }),
          ],
        };
      },
    ),
  };
  return { adapter, asked };
}

async function drain(stream: {
  next(): Promise<unknown>;
}): Promise<unknown[]> {
  const all: unknown[] = [];
  for (;;) {
    const next = await stream.next();
    if (next === undefined) return all;
    all.push(next);
  }
}

describe("lazyCandidateStream", () => {
  const times = ["12:00", "12:15", "12:30", "13:00", "13:15"];
  const all = () => baseOf(...times.map((time) => candidateAt(time)));

  it("looks up only the best time before handing back the first candidate", async () => {
    const { adapter, asked } = discovery();
    const stream = lazyCandidateStream(adapter, target, all(), { preferredOnly: false });

    const first = await stream.next();

    expect(first).toMatchObject({ localTime: "12:30" });
    expect(asked).toEqual(["base-12:30"]);
  });

  it("works outward from the preferred time, one time per request", async () => {
    const { adapter, asked } = discovery();
    const stream = lazyCandidateStream(adapter, target, all(), { preferredOnly: false });

    const order = (await drain(stream)) as Array<{ localTime: string }>;

    expect(order.map((slot) => slot.localTime)).toEqual([
      "12:30",
      "12:15",
      "12:00",
      "13:00",
      "13:15",
    ]);
    expect(asked).toEqual(order.map((slot) => `base-${slot.localTime}`));
  });

  it("looks up slots offered at the same time together before choosing among them", async () => {
    const { adapter, asked } = discovery();
    const base = baseOf(
      candidateAt("12:30", "late-order"),
      candidateAt("12:30", "early-order"),
      candidateAt("13:00"),
    );
    const stream = lazyCandidateStream(adapter, target, base, { preferredOnly: false });

    await stream.next();

    expect(asked.sort()).toEqual(["early-order", "late-order"]);
  });

  it("looks up the slots at one time in parallel, but never fetches a later time ahead", async () => {
    let inFlight = 0;
    let peak = 0;
    const asked: string[] = [];
    const adapter: LazyDiningAreaDiscovery = {
      findBaseSlots: vi.fn(),
      discoverDiningAreas: vi.fn(
        async (_target, candidate: DiscoverableSlot): Promise<DiningAreaDiscovery> => {
          asked.push(candidate.slot.id);
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 10));
          inFlight -= 1;
          return {
            slots: [
              makeSlot({
                id: `exact-${candidate.slot.id}`,
                localTime: candidate.slot.localTime,
              }),
            ],
          };
        },
      ),
    };
    const base = baseOf(
      candidateAt("12:30", "standard-12:30"),
      candidateAt("12:30", "outdoor-12:30"),
      candidateAt("13:00"),
    );
    const stream = lazyCandidateStream(adapter, target, base, { preferredOnly: false });

    await stream.next();

    expect(peak).toBe(2);
    expect(asked.sort()).toEqual(["outdoor-12:30", "standard-12:30"]);
  });

  it("skips a time that cannot be established and carries on", async () => {
    const { adapter } = discovery(new Set(["base-12:30"]));
    const stream = lazyCandidateStream(adapter, target, all(), { preferredOnly: false });

    const first = await stream.next();

    expect(first).toMatchObject({ localTime: "12:15" });
  });

  it("fails closed when every time it looks up is skipped", async () => {
    const { adapter } = discovery(new Set(times.map((time) => `base-${time}`)));
    const stream = lazyCandidateStream(adapter, target, all(), { preferredOnly: false });

    await expect(stream.next()).rejects.toMatchObject({
      category: AdapterFailureCategory.UNEXPECTED_RESPONSE,
    });
  });

  it("with preferredOnly, looks up nothing but the preferred time", async () => {
    const { adapter, asked } = discovery();
    const stream = lazyCandidateStream(adapter, target, all(), { preferredOnly: true });

    const order = await drain(stream);

    expect(order).toHaveLength(1);
    expect(asked).toEqual(["base-12:30"]);
  });

  it("counts what it has established so far", async () => {
    const { adapter } = discovery();
    const stream = lazyCandidateStream(adapter, target, all(), { preferredOnly: false });

    await stream.next();
    expect(stream.stats()).toEqual({ acceptable: 1, preferred: 1 });

    await drain(stream);
    expect(stream.stats()).toEqual({ acceptable: 5, preferred: 1 });
  });

  it("marks times it never looked up so they are not read as having no area", async () => {
    const { adapter } = discovery();
    const base = all();
    const stream = lazyCandidateStream(adapter, target, base, { preferredOnly: false });

    await stream.next();
    stream.finish();

    const byTime = new Map(
      base.observedSlots.map((slot) => [slot.localTime, slot]),
    );
    expect(byTime.get("12:30")?.diningAreas).toEqual(["Dining Room"]);
    expect(byTime.get("12:30")?.diningAreaIssue).toBeUndefined();
    expect(byTime.get("13:15")?.diningAreaIssue).toContain("Not checked");
  });

  it("leaves unchecked times alone when only the preferred time is ever booked", async () => {
    const { adapter } = discovery();
    const base = all();
    const stream = lazyCandidateStream(adapter, target, base, { preferredOnly: true });

    await stream.next();
    stream.finish();

    expect(base.observedSlots.every((slot) => slot.diningAreaIssue === undefined)).toBe(true);
  });
});

describe("eagerCandidateStream", () => {
  const slots = ["12:00", "12:30", "13:00"].map((time) =>
    makeSlot({ id: `slot-${time}`, localTime: time }),
  );

  it("ranks every slot it was given", async () => {
    const stream = eagerCandidateStream(target, slots, { preferredOnly: false });

    const order = (await drain(stream)) as Array<{ localTime: string }>;

    expect(order.map((slot) => slot.localTime)).toEqual(["12:30", "12:00", "13:00"]);
    expect(stream.stats()).toEqual({ acceptable: 3, preferred: 1 });
  });

  it("with preferredOnly, offers only the preferred time", async () => {
    const stream = eagerCandidateStream(target, slots, { preferredOnly: true });

    const order = (await drain(stream)) as Array<{ localTime: string }>;

    expect(order.map((slot) => slot.localTime)).toEqual(["12:30"]);
  });
});
