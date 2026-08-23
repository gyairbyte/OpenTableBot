export const AdapterFailureCategory = {
  AUTHENTICATION_REQUIRED: "AUTHENTICATION_REQUIRED",
  AUTHENTICATION_EXPIRED: "AUTHENTICATION_EXPIRED",
  CAPTCHA_OR_CHALLENGE: "CAPTCHA_OR_CHALLENGE",
  ACCESS_CONTROL_RESPONSE: "ACCESS_CONTROL_RESPONSE",
  RATE_LIMITED: "RATE_LIMITED",
  SLOT_DISAPPEARED: "SLOT_DISAPPEARED",
  TRANSIENT_TRANSPORT: "TRANSIENT_TRANSPORT",
  UNEXPECTED_RESPONSE: "UNEXPECTED_RESPONSE",
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
  AdapterFailureCategory.TRANSIENT_TRANSPORT,
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
