import { describe, expect, it } from "vitest";
import type { OpenTableReadAdapter } from "../src/opentable/adapter.js";
import {
  AdapterFailureCategory,
} from "../src/opentable/errors.js";
import type { OpenTableAdapterError } from "../src/opentable/errors.js";
import type {
  BrowserAvailabilityResult,
  OpenTableBrowserSessionPort,
} from "../src/opentable/playwright/browser-session.js";
import type { OpenTablePageEvidence } from "../src/opentable/playwright/page-classifier.js";
import { PlaywrightOpenTableReadAdapter } from "../src/opentable/playwright/read-adapter.js";
import { makeTarget } from "./fixtures.js";
import { makeAvailabilityObservation } from "./opentable-fixtures.js";

const authenticatedEvidence: OpenTablePageEvidence = {
  url: "https://www.opentable.com/user/dining-dashboard",
  title: "My reservations",
  bodyText: "Dining history",
  httpStatus: 200,
  authenticatedSignals: ["authenticated-url", "authenticated-content"],
  unauthenticatedSignals: [],
};

const normalEvidence: OpenTablePageEvidence = {
  url: "https://www.opentable.com/s",
  title: "Restaurant availability",
  bodyText: "Choose a time",
  httpStatus: 200,
  authenticatedSignals: [],
  unauthenticatedSignals: [],
};

class FakeBrowserSession implements OpenTableBrowserSessionPort {
  constructor(private readonly availabilityResult: BrowserAvailabilityResult) {}

  async start(): Promise<void> {}
  async close(): Promise<void> {}
  async openLoginPage(): Promise<void> {}
  async getAuthenticationEvidence(): Promise<OpenTablePageEvidence> {
    return authenticatedEvidence;
  }
  async observeAvailability(): Promise<BrowserAvailabilityResult> {
    return this.availabilityResult;
  }
}

describe("PlaywrightOpenTableReadAdapter", () => {
  it("implements only the read contract and returns verified normalized slots", async () => {
    const adapter: OpenTableReadAdapter = new PlaywrightOpenTableReadAdapter(
      new FakeBrowserSession({
        pageEvidence: normalEvidence,
        outcome: {
          kind: "availability",
          observation: makeAvailabilityObservation(),
        },
      }),
    );

    const slots = await adapter.findSlots(makeTarget());
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      restaurantId: "restaurant-123",
      localDate: "2026-09-01",
      partySize: 2,
    });
    expect("prepareBooking" in adapter).toBe(false);
    expect("book" in adapter).toBe(false);
  });

  it("does not return slots when response invariants fail", async () => {
    const adapter = new PlaywrightOpenTableReadAdapter(
      new FakeBrowserSession({
        pageEvidence: normalEvidence,
        outcome: {
          kind: "availability",
          observation: makeAvailabilityObservation({
            requestContext: {
              ...makeAvailabilityObservation().requestContext,
              partySize: 5,
            },
          }),
        },
      }),
    );

    await expect(adapter.findSlots(makeTarget())).rejects.toMatchObject({
      category: AdapterFailureCategory.INVARIANT_MISMATCH,
    } satisfies Partial<OpenTableAdapterError>);
  });
});
