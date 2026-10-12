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
