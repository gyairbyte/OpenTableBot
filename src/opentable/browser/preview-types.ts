import { z } from "zod";

const SafeTextSchema = z.string().min(1).max(2_000);

export const SafeBookingPreviewDataSchema = z
  .object({
    restaurantId: z.union([z.string(), z.number()]),
    restaurantName: z.string().min(1).max(200).optional(),
    reservationDateTime: z.string().min(16).max(40),
    partySize: z.number().int().positive().max(50),
    seatingType: z.string().min(1).max(100),
    reservationType: z.string().min(1).max(100).optional(),
    creditCardRequired: z.boolean().optional(),
    creditCardPolicyType: z.string().min(1).max(100).optional(),
    creditCardDepositAmount: z.number().nonnegative().optional(),
    currencyCode: z.string().regex(/^[A-Z]{3}$/u).optional(),
    cancellationMessage: SafeTextSchema.optional(),
    depositMessage: SafeTextSchema.optional(),
    termsMessage: SafeTextSchema.optional(),
    strongAuthenticationRequired: z.boolean().optional(),
    diningArea: z
      .object({
        id: z.number().int().positive(),
        tableCategory: z.string().min(1).max(100),
      })
      .strict(),
    experience: z
      .object({
        id: z.union([z.string(), z.number()]),
        name: z.string().min(1).max(200),
        type: z.string().min(1).max(100).optional(),
        summary: SafeTextSchema.optional(),
        pricePerCover: z.number().nonnegative().optional(),
        currencyCode: z.string().regex(/^[A-Z]{3}$/u).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type SafeBookingPreviewData = z.infer<
  typeof SafeBookingPreviewDataSchema
>;
