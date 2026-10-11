import { describe, expect, it } from "vitest";
import {
  AdapterFailureCategory,
  AdapterFailureDisposition,
  dispositionForAdapterFailure,
} from "../src/opentable/errors.js";

describe("adapter failure disposition", () => {
  it.each([
    AdapterFailureCategory.AUTHENTICATION_REQUIRED,
    AdapterFailureCategory.AUTHENTICATION_EXPIRED,
    AdapterFailureCategory.CAPTCHA_OR_CHALLENGE,
    AdapterFailureCategory.ACCESS_CONTROL_RESPONSE,
    AdapterFailureCategory.INVARIANT_MISMATCH,
    AdapterFailureCategory.MALFORMED_RESPONSE,
    AdapterFailureCategory.UNEXPECTED_RESPONSE,
    AdapterFailureCategory.UNKNOWN,
  ])("fails closed for %s", (category) => {
    expect(dispositionForAdapterFailure(category)).toBe(
      AdapterFailureDisposition.PAUSE,
    );
  });

  it.each([
    AdapterFailureCategory.RATE_LIMITED,
    AdapterFailureCategory.SLOT_DISAPPEARED,
    AdapterFailureCategory.TRANSIENT_TRANSPORT,
    AdapterFailureCategory.BROWSER_NOT_READY,
  ])("marks %s for a normal retry through WAITING", (category) => {
    expect(dispositionForAdapterFailure(category)).toBe(
      AdapterFailureDisposition.RETRY_WAITING,
    );
  });
});
