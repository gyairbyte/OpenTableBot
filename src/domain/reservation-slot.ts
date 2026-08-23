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

export const BookingPreviewSchema = z.object({
  slotId: z.string().min(1),
  restaurantId: z.string().min(1),
  localDate: LocalDateSchema,
  localTime: LocalTimeSchema,
  partySize: z.number().int().positive(),
  seatingType: SeatingTypeSchema,
  prepaidRequired: z.boolean(),
  prepaidAmountCents: z.number().int().nonnegative().optional(),
  cancellationFeeCents: z.number().int().nonnegative().optional(),
  noShowFeeCents: z.number().int().nonnegative().optional(),
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
