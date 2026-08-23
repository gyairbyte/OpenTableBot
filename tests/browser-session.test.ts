import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveOpenTableProfileDirectory } from "../src/opentable/playwright/browser-session.js";

describe("dedicated browser profile resolution", () => {
  it("uses the ignored project-local profile when override is blank", () => {
    expect(resolveOpenTableProfileDirectory("   ")).toBe(
      path.resolve(".local", "opentable-browser-profile"),
    );
  });

  it("accepts an explicit dedicated profile override", () => {
    expect(resolveOpenTableProfileDirectory(".local/custom-profile")).toBe(
      path.resolve(".local", "custom-profile"),
    );
  });
});
