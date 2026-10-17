import { db } from "@/server/db";

export type Attention = { matches: number; listings: number; orders: number; total: number };

/** What is waiting on the admin: matches to review, drafts to approve or listings in error, orders that need a decision or failed. */
export async function getAttention(): Promise<Attention> {
  const [matches, listings, orders] = await Promise.all([
    db.productMatch.count({ where: { status: "REVIEW" } }),
    db.listing.count({ where: { status: { in: ["PENDING_APPROVAL", "DRAFT", "ERROR"] } } }),
    db.order.count({ where: { status: { in: ["NEEDS_DECISION", "FAILED"] } } }),
  ]);
  return { matches, listings, orders, total: matches + listings + orders };
}
