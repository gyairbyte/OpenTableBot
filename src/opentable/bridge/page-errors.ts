/**
 * Thrown by the page when the restaurant page has not yet made the availability
 * request the extension replays. It is a browser-state problem (a reloaded or
 * wrong tab), not a provider response, so the adapter maps it to a retryable
 * category. The bridge carries only the message, so both sides share this text.
 */
export const AVAILABILITY_OPERATION_NOT_OBSERVED_MESSAGE =
  "The RestaurantsAvailability operation has not been observed on this page";
