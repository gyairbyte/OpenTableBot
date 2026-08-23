import { z } from "zod";
import {
  LocalDateSchema,
  LocalTimeSchema,
  SeatingTypeSchema,
} from "./primitives.js";

export const ReservationSlotSchema = z.object({
  id: z.string().min(1),
  restaurantId: z.string().min(1),
  startsAt: z.string().datetime({ offset: true }),
  localDate: LocalDateSchema,
  localTime: LocalTimeSchema,
  partySize: z.number().int().positive(),
  seatingType: SeatingTypeSchema,
});

export type ReservationSlot = z.infer<typeof ReservationSlotSchema>;

/**
 * Provider-neutral financial exposure. `none` is confirmed zero; `unknown`
 * means the adapter could not establish the amount and must fail closed.
 */
export const FinancialTermSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("none") }),
  z.strictObject({
    status: z.literal("known"),
    amountCents: z.number().int().nonnegative(),
  }),
  z.strictObject({ status: z.literal("unknown") }),
]);

export type FinancialTerm = z.infer<typeof FinancialTermSchema>;

/** A prepaid requirement cannot exist without a known or explicitly unknown amount. */
export const PrepaidTermSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("not-required") }),
  z.strictObject({
    status: z.literal("required-known"),
    amountCents: z.number().int().nonnegative(),
  }),
  z.strictObject({ status: z.literal("required-unknown") }),
]);

export type PrepaidTerm = z.infer<typeof PrepaidTermSchema>;

export const BookingPreviewSchema = z.strictObject({
  slotId: z.string().min(1),
  restaurantId: z.string().min(1),
  localDate: LocalDateSchema,
  localTime: LocalTimeSchema,
  partySize: z.number().int().positive(),
  seatingType: SeatingTypeSchema,
  prepaid: PrepaidTermSchema,
  cancellationFee: FinancialTermSchema,
  noShowFee: FinancialTermSchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
  requiresStrongCustomerAuthentication: z.boolean(),
  isAmbiguous: z.boolean(),
});

export type BookingPreview = z.infer<typeof BookingPreviewSchema>;

export const BookingConfirmationSchema = z.object({
  confirmationId: z.string().min(1),
  slotId: z.string().min(1),
  restaurantId: z.string().min(1),
  startsAt: z.string().datetime({ offset: true }),
  partySize: z.number().int().positive(),
  seatingType: SeatingTypeSchema,
  bookedAt: z.string().datetime({ offset: true }),
});

export type BookingConfirmation = z.infer<typeof BookingConfirmationSchema>;
