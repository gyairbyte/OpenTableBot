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

/**
 * When the page's own `fetch` cannot reach OpenTable at all (dropped Wi-Fi,
 * DNS hiccup, a brief upstream reset) Chrome rejects with
 * `TypeError: Failed to fetch`, which the page forwards as the bare message.
 * No provider response exists to inspect, so a read-only availability poll
 * should simply try again on the next tick. Callers must only apply this to
 * read paths: after a lock or submission dispatch the same text is ambiguous.
 */
const PAGE_FETCH_NETWORK_FAILURE_PATTERN = /^Failed to fetch\b/;

export function isTransientPageFetchFailure(message: string): boolean {
  return PAGE_FETCH_NETWORK_FAILURE_PATTERN.test(message.trim());
}

/**
 * Dining-area discovery raises `BOOKING_PREVIEW_DINING_AREA_UNKNOWN` or
 * `BOOKING_PREVIEW_DINING_AREA_CONFLICT` when the booking-details response for
 * one slot cannot establish an exact dining area. That is a property of that
 * single slot, not of the scan, so the adapter skips the slot (it is never
 * booked) instead of failing the whole availability read.
 */
const SLOT_DINING_AREA_FAILURE_PATTERN = /\bBOOKING_PREVIEW_DINING_AREA_(?:UNKNOWN|CONFLICT):/;

export function isSlotDiningAreaDiscoveryFailure(message: string): boolean {
  return SLOT_DINING_AREA_FAILURE_PATTERN.test(message);
}
