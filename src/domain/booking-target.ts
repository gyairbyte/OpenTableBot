import { z } from "zod";
import { BookingPolicySchema } from "./booking-policy.js";
import {
  IanaTimeZoneSchema,
  LocalDateSchema,
  LocalTimeSchema,
  SeatingTypeSchema,
} from "./primitives.js";

export const BookingTargetModeSchema = z.enum([
  "known-drop",
  "cancellation-watch",
]);

export type BookingTargetMode = z.infer<typeof BookingTargetModeSchema>;

export const BookingTargetSchema = z
  .object({
    id: z.string().min(1),
    restaurant: z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      timeZone: IanaTimeZoneSchema,
    }),
    dateRange: z.object({
      startDate: LocalDateSchema,
      endDate: LocalDateSchema,
    }),
    partySize: z.number().int().min(1).max(20),
    timeWindow: z.object({
      earliest: LocalTimeSchema,
      latest: LocalTimeSchema,
      preferred: LocalTimeSchema,
    }),
    allowedSeatingTypes: z.array(SeatingTypeSchema).min(1),
    bookingPolicy: BookingPolicySchema,
    mode: BookingTargetModeSchema,
    knownReservationReleaseAt: z.string().datetime({ offset: true }).optional(),
  })
  .superRefine((target, context) => {
    if (target.dateRange.startDate > target.dateRange.endDate) {
      context.addIssue({
        code: "custom",
        path: ["dateRange", "endDate"],
        message: "End date must be on or after start date",
      });
    }
    if (target.timeWindow.earliest > target.timeWindow.latest) {
      context.addIssue({
        code: "custom",
        path: ["timeWindow", "latest"],
        message: "Latest time must be on or after earliest time",
      });
    }
    if (
      target.timeWindow.preferred < target.timeWindow.earliest ||
      target.timeWindow.preferred > target.timeWindow.latest
    ) {
      context.addIssue({
        code: "custom",
        path: ["timeWindow", "preferred"],
        message: "Preferred time must be within the acceptable window",
      });
    }
    if (new Set(target.allowedSeatingTypes).size !== target.allowedSeatingTypes.length) {
      context.addIssue({
        code: "custom",
        path: ["allowedSeatingTypes"],
        message: "Allowed seating types must be unique and ordered by preference",
      });
    }
  });

export type BookingTarget = z.infer<typeof BookingTargetSchema>;
