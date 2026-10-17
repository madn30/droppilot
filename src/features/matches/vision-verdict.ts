import { z } from "zod";

/** Shape of ProductMatch.visionVerdict as stored by the matching run. */
export const visionVerdictSchema = z.object({
  same: z.boolean(),
  confidence: z.number(),
  differences: z.array(z.string()),
});
