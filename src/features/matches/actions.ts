"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/server/auth/session";
import { setMatchDecision } from "@/server/matching/decisions";

const decisionSchema = z.object({
  matchId: z.string().min(1),
  decision: z.enum(["CONFIRMED", "REJECTED"]),
});

export async function decideMatchAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const { matchId, decision } = decisionSchema.parse({
    matchId: formData.get("matchId"),
    decision: formData.get("decision"),
  });
  await setMatchDecision(matchId, decision);
  revalidatePath("/products");
}
