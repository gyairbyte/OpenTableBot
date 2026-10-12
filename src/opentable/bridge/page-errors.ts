/**
 * Thrown by the page when the restaurant page has not yet made the availability
 * request the extension replays. It is a browser-state problem (a reloaded or
 * wrong tab), not a provider response, so the adapter maps it to a retryable
 * category. The bridge carries only the message, so both sides share this text.
 */
export const AVAILABILITY_OPERATION_NOT_OBSERVED_MESSAGE =
  "The RestaurantsAvailability operation has not been observed on this page";

/**
 * Prefix of the message the extension raises when an availability response
 * carries GraphQL `errors`. These have been seen mid-watch after dozens of
 * clean polls, so the adapter treats them as retryable rather than pausing.
 */
export const AVAILABILITY_PROVIDER_ERRORS_MESSAGE =
  "RestaurantsAvailability returned provider errors";

/**
 * The page raises `RestaurantsAvailability HTTP <status>; ...` when the
 * replayed request gets a non-2xx response. A gateway failure (502, 503, 504)
 * is OpenTable being briefly unreachable, so a watcher that has polled cleanly
 * for hours should survive it. Other statuses (401, 403, 404, ...) still pause.
 */
const AVAILABILITY_HTTP_STATUS_PATTERN = /\bRestaurantsAvailability HTTP (\d{3})\b/;
const TRANSIENT_AVAILABILITY_HTTP_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

export function isTransientAvailabilityHttpFailure(message: string): boolean {
  const status = AVAILABILITY_HTTP_STATUS_PATTERN.exec(message)?.[1];
  return status !== undefined && TRANSIENT_AVAILABILITY_HTTP_STATUSES.has(Number(status));
}
