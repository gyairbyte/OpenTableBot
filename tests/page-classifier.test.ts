import { describe, expect, it } from "vitest";
import {
  classifyOpenTablePage,
  OpenTablePageKind,
  type OpenTablePageEvidence,
} from "../src/opentable/playwright/page-classifier.js";

function evidence(
  overrides: Partial<OpenTablePageEvidence> = {},
): OpenTablePageEvidence {
  return {
    url: "https://www.opentable.com/user/dining-dashboard",
    title: "My reservations",
    bodyText: "Dining history",
    httpStatus: 200,
    authenticatedSignals: ["authenticated-url", "authenticated-content"],
    unauthenticatedSignals: [],
    ...overrides,
  };
}

describe("OpenTable page classification", () => {
  it("classifies an authenticated normal page using multiple signals", () => {
    expect(classifyOpenTablePage(evidence()).kind).toBe(
      OpenTablePageKind.AUTHENTICATED,
    );
  });

  it("classifies a sign-in page as unauthenticated", () => {
    expect(
      classifyOpenTablePage(
        evidence({
          url: "https://www.opentable.com/login",
          title: "Sign in",
          bodyText: "Sign in to continue",
          authenticatedSignals: [],
          unauthenticatedSignals: ["login-link"],
        }),
      ).kind,
    ).toBe(OpenTablePageKind.UNAUTHENTICATED);
  });

  it("requires combined sign-in evidence when the URL does not redirect", () => {
    expect(
      classifyOpenTablePage(
        evidence({
          url: "https://www.opentable.com/user/dining-dashboard",
          title: "OpenTable",
          bodyText: "Sign in to OpenTable",
          authenticatedSignals: [],
          unauthenticatedSignals: ["sign-in-control", "unauthenticated-content"],
        }),
      ).kind,
    ).toBe(OpenTablePageKind.UNAUTHENTICATED);
  });

  it("recognizes OpenTable's normal authentication-start redirect", () => {
    expect(
      classifyOpenTablePage(
        evidence({
          url: "https://www.opentable.com/authenticate/start",
          title: "Log In / Sign Up",
          bodyText: "Log in",
          authenticatedSignals: [],
          unauthenticatedSignals: ["unauthenticated-content"],
        }),
      ).kind,
    ).toBe(OpenTablePageKind.UNAUTHENTICATED);
  });

  it("classifies a CAPTCHA or challenge and fails before access status", () => {
    expect(
      classifyOpenTablePage(
        evidence({
          httpStatus: 403,
          title: "Security check",
          bodyText: "Verify you are human",
          authenticatedSignals: [],
        }),
      ).kind,
    ).toBe(OpenTablePageKind.CHALLENGE);
  });

  it("classifies access denied", () => {
    expect(
      classifyOpenTablePage(
        evidence({
          httpStatus: 403,
          title: "Access denied",
          bodyText: "Request blocked",
          authenticatedSignals: [],
        }),
      ).kind,
    ).toBe(OpenTablePageKind.ACCESS_DENIED);
  });

  it("classifies rate limiting", () => {
    expect(
      classifyOpenTablePage(
        evidence({
          httpStatus: 429,
          title: "Too many requests",
          bodyText: "Try again later",
          authenticatedSignals: [],
        }),
      ).kind,
    ).toBe(OpenTablePageKind.RATE_LIMITED);
  });
});
