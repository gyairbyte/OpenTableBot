import { z } from "zod";
import { DiningAreaOptionSchema } from "../../domain/dining-area.js";

export const SafeDiningAreaCandidateSchema = z.strictObject({
  previewReference: z.string().uuid(),
  diningArea: DiningAreaOptionSchema,
});

export const SafeDiningAreaCandidatesSchema = z.array(SafeDiningAreaCandidateSchema);

export type SafeDiningAreaCandidate = z.infer<typeof SafeDiningAreaCandidateSchema>;
