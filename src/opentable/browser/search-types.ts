import { z } from "zod";

/**
 * Provider-neutral restaurant search result. Everything here is safe to leave
 * Chrome: no URLs beyond the restaurant profile link, no raw page state, and
 * every text field is bounded.
 */
export const SafeSearchResultSchema = z
  .object({
    restaurantId: z.string().min(1).max(80),
    name: z.string().min(1).max(200),
    /** OpenTable restaurant profile path (or absolute profile URL). */
    profileUrl: z.string().min(1).max(300),
    /** False for Listing-type venues that have no booking flow. */
    bookable: z.boolean(),
    cuisine: z.string().min(1).max(100).optional(),
    metro: z.string().min(1).max(100).optional(),
    priceBand: z.string().min(1).max(20).optional(),
  })
  .strict();

export type SafeSearchResult = z.infer<typeof SafeSearchResultSchema>;

export const SafeSearchResultsSchema = z
  .object({
    results: z.array(SafeSearchResultSchema).max(30),
  })
  .strict();

export type SafeSearchResults = z.infer<typeof SafeSearchResultsSchema>;
