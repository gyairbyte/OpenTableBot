import { z } from "zod";
import { DiningAreaOptionSchema } from "../../domain/dining-area.js";

/**
 * Strips unknown provider fields at the parse boundary. Only the allowlisted
 * fields below may leave Chrome.
 */
export const SafeDiningAreaCandidateSchema = z.object({
  previewReference: z.string().uuid(),
  diningArea: DiningAreaOptionSchema,
});

export const SafeDiningAreaCandidatesSchema = z.array(SafeDiningAreaCandidateSchema);

export type SafeDiningAreaCandidate = z.infer<typeof SafeDiningAreaCandidateSchema>;
