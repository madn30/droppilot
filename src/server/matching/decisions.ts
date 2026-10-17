import { db } from "../db";
import { refreshUniqueFlag } from "./run-matching";

/**
 * Records the user's verdict on a match. It overrides the algorithm and
 * survives later re-runs of matching.
 */
export async function setMatchDecision(matchId: string, status: "CONFIRMED" | "REJECTED"): Promise<void> {
  const match = await db.productMatch.update({
    where: { id: matchId },
    data: { status, decidedBy: "USER", decidedAt: new Date() },
  });
  await refreshUniqueFlag(match.variantId);
}
