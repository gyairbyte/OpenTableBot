export const AdapterFailureCategory = {
  AUTHENTICATION_REQUIRED: "AUTHENTICATION_REQUIRED",
  AUTHENTICATION_EXPIRED: "AUTHENTICATION_EXPIRED",
  CAPTCHA_OR_CHALLENGE: "CAPTCHA_OR_CHALLENGE",
  ACCESS_CONTROL_RESPONSE: "ACCESS_CONTROL_RESPONSE",
  RATE_LIMITED: "RATE_LIMITED",
  SLOT_DISAPPEARED: "SLOT_DISAPPEARED",
  LOCK_REJECTED: "LOCK_REJECTED",
  LOCK_NOT_DISPATCHED: "LOCK_NOT_DISPATCHED",
  LOCK_OUTCOME_UNKNOWN: "LOCK_OUTCOME_UNKNOWN",
  LOCK_EXPIRED: "LOCK_EXPIRED",
  REVALIDATION_OUTCOME_UNKNOWN: "REVALIDATION_OUTCOME_UNKNOWN",
  TERMS_CHANGED: "TERMS_CHANGED",
  POLICY_REJECTED: "POLICY_REJECTED",
  PAYMENT_REQUIRED: "PAYMENT_REQUIRED",
  STRONG_AUTHENTICATION_REQUIRED: "STRONG_AUTHENTICATION_REQUIRED",
  SUBMISSION_REJECTED: "SUBMISSION_REJECTED",
  SUBMISSION_OUTCOME_UNKNOWN: "SUBMISSION_OUTCOME_UNKNOWN",
  DUPLICATE_SUBMISSION_PREVENTED: "DUPLICATE_SUBMISSION_PREVENTED",
  TRANSIENT_TRANSPORT: "TRANSIENT_TRANSPORT",
  INVARIANT_MISMATCH: "INVARIANT_MISMATCH",
  MALFORMED_RESPONSE: "MALFORMED_RESPONSE",
  UNEXPECTED_RESPONSE: "UNEXPECTED_RESPONSE",
  BROWSER_NOT_READY: "BROWSER_NOT_READY",
  UNKNOWN: "UNKNOWN",
} as const;

export type AdapterFailureCategory =
  (typeof AdapterFailureCategory)[keyof typeof AdapterFailureCategory];

export const AdapterFailureDisposition = {
  RETRY_WAITING: "RETRY_WAITING",
  PAUSE: "PAUSE",
} as const;

export type AdapterFailureDisposition =
  (typeof AdapterFailureDisposition)[keyof typeof AdapterFailureDisposition];

const retryableCategories: ReadonlySet<AdapterFailureCategory> = new Set([
  AdapterFailureCategory.RATE_LIMITED,
  AdapterFailureCategory.SLOT_DISAPPEARED,
  AdapterFailureCategory.LOCK_NOT_DISPATCHED,
  AdapterFailureCategory.TRANSIENT_TRANSPORT,
  AdapterFailureCategory.BROWSER_NOT_READY,
]);

export function dispositionForAdapterFailure(
  category: AdapterFailureCategory,
): AdapterFailureDisposition {
  return retryableCategories.has(category)
    ? AdapterFailureDisposition.RETRY_WAITING
    : AdapterFailureDisposition.PAUSE;
}

export class OpenTableAdapterError extends Error {
  readonly disposition: AdapterFailureDisposition;

  constructor(
    readonly category: AdapterFailureCategory,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OpenTableAdapterError";
    this.disposition = dispositionForAdapterFailure(category);
  }
}
