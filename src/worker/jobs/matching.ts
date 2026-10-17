import type { Queue } from "bullmq";
import { z } from "zod";
import { db } from "@/server/db";
import { buildDemandDeps } from "@/server/demand/deps";
import { scoreDemandForVariant } from "@/server/demand/run-demand";
import { buildMatchingDeps } from "@/server/matching/deps";
import { findVariantsWithNewCompetitors } from "@/server/matching/watch";
import { type MatchingSummary, runMatchingForVariant } from "@/server/matching/run-matching";
import { MATCH_VARIANT_JOB } from "../queues";

const matchVariantDataSchema = z.object({ variantId: z.string().min(1) });

/** Re-matches one variant, then re-scores its demand from the refreshed matches. */
export async function matchVariant(data: unknown): Promise<MatchingSummary & { demandScore: number }> {
  const { variantId } = matchVariantDataSchema.parse(data);
  const summary = await runMatchingForVariant(variantId, await buildMatchingDeps());
  const demand = await scoreDemandForVariant(variantId, await buildDemandDeps());
  return { ...summary, demandScore: demand.score };
}

/**
 * Queues a matching run for every variant of a product that is still in play.
 * The job id carries the date, so a schedule that fires twice on one day
 * queues each variant only once.
 */
export async function scheduleMatching(queue: Queue, now: Date = new Date()): Promise<{ queued: number }> {
  const variants = await db.productVariant.findMany({
    where: { product: { status: { notIn: ["REJECTED", "ARCHIVED"] } } },
    select: { id: true },
  });
  const day = now.toISOString().slice(0, 10);
  await queue.addBulk(
    variants.map((variant) => ({
      name: MATCH_VARIANT_JOB,
      data: { variantId: variant.id },
      opts: { jobId: `${MATCH_VARIANT_JOB}-${variant.id}-${day}` },
    })),
  );
  return { queued: variants.length };
}

/** Queues an early matching run for variants whose marketplace search shows a listing not seen before. */
export async function watchCompetitors(queue: Queue, now: Date = new Date()): Promise<{ queued: number }> {
  const { marketplaces } = await buildMatchingDeps();
  const variantIds = await findVariantsWithNewCompetitors(marketplaces);
  const day = now.toISOString().slice(0, 10);
  await queue.addBulk(
    variantIds.map((variantId) => ({
      name: MATCH_VARIANT_JOB,
      data: { variantId },
      opts: { jobId: `${MATCH_VARIANT_JOB}-${variantId}-${day}` },
    })),
  );
  return { queued: variantIds.length };
}
