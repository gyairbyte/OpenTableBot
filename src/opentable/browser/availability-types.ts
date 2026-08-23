import { z } from "zod";

export interface AvailabilityRequestContext {
  readonly restaurantIds: readonly string[];
  readonly date?: string;
  readonly time?: string;
  readonly partySize?: number;
}

export interface AvailabilityObservation {
  readonly requestContext: AvailabilityRequestContext;
  readonly payload: unknown;
}

const SafeAvailabilitySlotSchema = z
  .object({
    isAvailable: z.boolean(),
    timeOffsetMinutes: z.number().int().optional(),
    attributes: z.array(z.string()).optional(),
    type: z.string().optional(),
    dateTime: z.string().optional(),
    startDateTime: z.string().optional(),
  })
  .strict();

const SafeAvailabilityDaySchema = z
  .object({
    dayOffset: z.number().int(),
    slots: z.array(SafeAvailabilitySlotSchema),
  })
  .strict();

const SafeRestaurantAvailabilitySchema = z
  .object({
    restaurantId: z.union([z.string(), z.number()]),
    availabilityDays: z.array(SafeAvailabilityDaySchema),
  })
  .strict();

/**
 * The only OpenTable response fields allowed to leave Chrome in Phase 1B.
 * Booking hashes/tokens, account data, cookies, and storage values are absent.
 */
export const SafeAvailabilityDataSchema = z
  .object({
    availability: z.array(SafeRestaurantAvailabilitySchema),
  })
  .strict();

export type SafeAvailabilityData = z.infer<typeof SafeAvailabilityDataSchema>;
