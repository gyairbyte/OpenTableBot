import { describe, expect, it } from "vitest";
import { parseActivePage } from "../extension/src/active-page.js";

describe("parseActivePage", () => {
  it("accepts a well-formed persisted OpenTable page", () => {
    expect(
      parseActivePage({ tabId: 42, pageUrl: "https://www.opentable.com/catch-new-york" }),
    ).toEqual({ tabId: 42, pageUrl: "https://www.opentable.com/catch-new-york" });
  });

  it("rejects non-objects and null", () => {
    expect(parseActivePage(undefined)).toBeUndefined();
    expect(parseActivePage(null)).toBeUndefined();
    expect(parseActivePage("https://www.opentable.com/")).toBeUndefined();
  });

  it("rejects a non-integer or negative tab id", () => {
    expect(parseActivePage({ tabId: 1.5, pageUrl: "https://www.opentable.com/" })).toBeUndefined();
    expect(parseActivePage({ tabId: -1, pageUrl: "https://www.opentable.com/" })).toBeUndefined();
    expect(parseActivePage({ tabId: "3", pageUrl: "https://www.opentable.com/" })).toBeUndefined();
  });

  it("rejects a non-OpenTable or malformed url", () => {
    expect(parseActivePage({ tabId: 1, pageUrl: "https://example.com/" })).toBeUndefined();
    expect(parseActivePage({ tabId: 1, pageUrl: "not a url" })).toBeUndefined();
    expect(parseActivePage({ tabId: 1, pageUrl: "" })).toBeUndefined();
  });
});
