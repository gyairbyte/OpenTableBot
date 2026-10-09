export const OpenTablePageKind = {
  AUTHENTICATED: "AUTHENTICATED",
  NORMAL: "NORMAL",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  CHALLENGE: "CHALLENGE",
  ACCESS_DENIED: "ACCESS_DENIED",
  RATE_LIMITED: "RATE_LIMITED",
  UNEXPECTED: "UNEXPECTED",
} as const;

export type OpenTablePageKind =
  (typeof OpenTablePageKind)[keyof typeof OpenTablePageKind];

export interface OpenTablePageEvidence {
  readonly url: string;
  readonly title: string;
  readonly bodyText: string;
  readonly httpStatus?: number;
  readonly authenticatedSignals: readonly string[];
  readonly unauthenticatedSignals: readonly string[];
}

export interface OpenTablePageClassification {
  readonly kind: OpenTablePageKind;
  readonly reason: string;
}

const challengePattern =
  /captcha|verify (?:that )?you are human|security check|unusual traffic|robot check|akamai/i;
const accessDeniedPattern =
  /access denied|request blocked|forbidden|not authorized to access|permission denied/i;
const rateLimitedPattern = /too many requests|rate limit|try again later/i;
const signInUrlPattern =
  /\/(?:login|sign-in|signin)(?:[/?#]|$)|\/authenticate\/start(?:[/?#]|$)/i;

function isOpenTableHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "www.opentable.com";
  } catch {
    return false;
  }
}

/** Pure, conservative classification of browser-visible page evidence. */
export function classifyOpenTablePage(
  evidence: OpenTablePageEvidence,
): OpenTablePageClassification {
  const searchableText = `${evidence.title}\n${evidence.bodyText}`;

  if (evidence.httpStatus === 429 || rateLimitedPattern.test(searchableText)) {
    return { kind: OpenTablePageKind.RATE_LIMITED, reason: "rate limited" };
  }
  if (challengePattern.test(searchableText)) {
    return {
      kind: OpenTablePageKind.CHALLENGE,
      reason: "challenge or CAPTCHA detected",
    };
  }
  if (
    evidence.httpStatus === 403 ||
    accessDeniedPattern.test(searchableText)
  ) {
    return {
      kind: OpenTablePageKind.ACCESS_DENIED,
      reason: "access denied or blocked",
    };
  }
  if (
    evidence.httpStatus === 401 ||
    signInUrlPattern.test(evidence.url) ||
    (evidence.unauthenticatedSignals.length >= 2 &&
      evidence.authenticatedSignals.length === 0)
  ) {
    return {
      kind: OpenTablePageKind.UNAUTHENTICATED,
      reason: "sign-in required",
    };
  }
  if (evidence.authenticatedSignals.length >= 2) {
    return {
      kind: OpenTablePageKind.AUTHENTICATED,
      reason: "multiple authenticated-session signals detected",
    };
  }
  if (
    isOpenTableHost(evidence.url) &&
    evidence.authenticatedSignals.length >= 1 &&
    evidence.unauthenticatedSignals.length === 0
  ) {
    return {
      kind: OpenTablePageKind.AUTHENTICATED,
      reason: "authenticated-session signal on OpenTable page with no unauthenticated signals",
    };
  }
  if (
    evidence.httpStatus !== undefined &&
    evidence.httpStatus >= 200 &&
    evidence.httpStatus < 400
  ) {
    return { kind: OpenTablePageKind.NORMAL, reason: "normal page" };
  }
  return {
    kind: OpenTablePageKind.UNEXPECTED,
    reason: "page could not be classified safely",
  };
}
