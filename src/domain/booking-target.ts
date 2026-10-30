import { z } from "zod";
import { BookingPolicySchema } from "./booking-policy.js";
import {
  IanaTimeZoneSchema,
  LocalDateSchema,
  LocalTimeSchema,
  SeatingTypeSchema,
} from "./primitives.js";
import {
  DiningAreaPolicySchema,
} from "./dining-area.js";

export const BookingTargetModeSchema = z.enum([
  "known-drop",
  "cancellation-watch",
]);

export type BookingTargetMode = z.infer<typeof BookingTargetModeSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Targets stored before the policy caps moved from integer cents to dollars
 * still carry the legacy field names. Map them once at the schema boundary so
 * old state files keep loading. The cancellation/no-show cap also changed
 * meaning, from a per-booking total to a per-person amount, so the legacy
 * total is divided by the party size and rounded down to the cent, which can
 * only shrink the authorization. New fields, when present, win over legacy
 * ones.
 */
function migrateLegacyPolicyAmounts(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.bookingPolicy)) return value;
  const policy = value.bookingPolicy;
  const legacyPrepaidCents = policy.maxAuthorizedPrepaidCents;
  const legacyCancellationCents = policy.maxAuthorizedCancellationNoShowCents;
  if (
    typeof legacyPrepaidCents !== "number" &&
    typeof legacyCancellationCents !== "number"
  ) {
    return value;
  }
  const partySize =
    typeof value.partySize === "number" &&
    Number.isInteger(value.partySize) &&
    value.partySize >= 1
      ? value.partySize
      : 1;
  const rest = { ...policy };
  delete rest.maxAuthorizedPrepaidCents;
  delete rest.maxAuthorizedCancellationNoShowCents;
  return {
    ...value,
    bookingPolicy: {
      ...rest,
      maxAuthorizedPrepaidDollars:
        rest.maxAuthorizedPrepaidDollars ??
        (typeof legacyPrepaidCents === "number"
          ? Math.round(legacyPrepaidCents) / 100
          : 0),
      maxAuthorizedCancellationNoShowDollarsPerPerson:
        rest.maxAuthorizedCancellationNoShowDollarsPerPerson ??
        (typeof legacyCancellationCents === "number"
          ? Math.floor(legacyCancellationCents / partySize) / 100
          : 0),
    },
  };
}

export const BookingTargetSchema = z.preprocess(
  migrateLegacyPolicyAmounts,
  z
  .object({
    id: z.string().min(1),
    restaurant: z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      timeZone: IanaTimeZoneSchema,
      /** OpenTable restaurant profile URL or relative profile path. */
      profileUrl: z.string().min(1).max(300).optional(),
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
    /** Compatibility shorthand. New targets should use diningAreaPolicy. */
    allowedSeatingTypes: z.array(SeatingTypeSchema).min(1).optional(),
    diningAreaPolicy: DiningAreaPolicySchema.optional(),
    bookingPolicy: BookingPolicySchema,
    mode: BookingTargetModeSchema,
    /**
     * Known-drop only. When set, a run books the acceptable time closest to
     * `timeWindow.preferred` anywhere in the window instead of requiring the
     * exact preferred time. A cancellation watcher always behaves this way.
     */
    acceptAnyTimeInWindow: z.boolean().optional(),
    knownReservationReleaseAt: z.string().datetime({ offset: true }).optional(),
    cancellationWatchStopAt: z.string().datetime({ offset: true }).optional(),
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
    if (
      target.allowedSeatingTypes !== undefined &&
      new Set(target.allowedSeatingTypes).size !== target.allowedSeatingTypes.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["allowedSeatingTypes"],
        message: "Allowed seating types must be unique and ordered by preference",
      });
    }
    if (target.allowedSeatingTypes !== undefined && target.diningAreaPolicy !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["diningAreaPolicy"],
        message: "Use diningAreaPolicy or legacy allowedSeatingTypes, not both",
      });
    }
  }),
);

export type BookingTarget = z.infer<typeof BookingTargetSchema>;

export { effectiveDiningAreaPolicy } from "./dining-area.js";
