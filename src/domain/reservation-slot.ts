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
  previewReference: z.string().uuid().optional(),
  reservationKind: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("standard") }),
    z.strictObject({
      kind: z.literal("experience"),
      experienceId: z.string().min(1),
      name: z.string().min(1).max(200).optional(),
      type: z.string().min(1).max(100).optional(),
      summary: z.string().min(1).max(2_000).optional(),
    }),
    z.strictObject({
      kind: z.literal("unknown"),
      providerType: z.string().min(1).max(100),
    }),
  ]),
});

export type ReservationSlot = z.infer<typeof ReservationSlotSchema>;

/**
 * Provider-neutral financial exposure. `none` is confirmed zero; `unknown`
 * means the adapter could not establish the amount and must fail closed.
 */
export const FinancialTermSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("none"),
    summary: z.string().min(1).max(2_000).optional(),
  }),
  z.strictObject({
    status: z.literal("known"),
    amountCents: z.number().int().nonnegative(),
    summary: z.string().min(1).max(2_000).optional(),
  }),
  z.strictObject({
    status: z.literal("unknown"),
    summary: z.string().min(1).max(2_000).optional(),
  }),
]);

export type FinancialTerm = z.infer<typeof FinancialTermSchema>;

/** A prepaid requirement cannot exist without a known or explicitly unknown amount. */
export const PrepaidTermSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("not-required"),
    summary: z.string().min(1).max(2_000).optional(),
  }),
  z.strictObject({
    status: z.literal("required-known"),
    amountCents: z.number().int().nonnegative(),
    summary: z.string().min(1).max(2_000).optional(),
  }),
  z.strictObject({
    status: z.literal("required-unknown"),
    summary: z.string().min(1).max(2_000).optional(),
  }),
]);

export type PrepaidTerm = z.infer<typeof PrepaidTermSchema>;

export const CurrencyTermSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("known"),
    code: z.string().regex(/^[A-Z]{3}$/),
  }),
  z.strictObject({ status: z.literal("unknown") }),
]);

export const PaymentRequirementSchema = z.enum([
  "not-required",
  "required",
  "unknown",
]);

export const StrongAuthenticationRequirementSchema = z.enum([
  "not-required",
  "required",
  "unknown",
]);

export const BookingPreviewSchema = z.strictObject({
  slotId: z.string().min(1),
  restaurantId: z.string().min(1),
  localDate: LocalDateSchema,
  localTime: LocalTimeSchema,
  partySize: z.number().int().positive(),
  seatingType: SeatingTypeSchema,
  reservationKind: ReservationSlotSchema.shape.reservationKind,
  prepaid: PrepaidTermSchema,
  cancellationFee: FinancialTermSchema,
  noShowFee: FinancialTermSchema,
  currency: CurrencyTermSchema,
  paymentRequirement: PaymentRequirementSchema,
  strongAuthentication: StrongAuthenticationRequirementSchema,
  termsSummary: z.string().min(1).max(2_000).optional(),
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
