import type { Queue } from "bullmq";
import { z } from "zod";
import { buildSyncDeps } from "@/server/listing/deps";
import { getSettings } from "@/server/settings/service";
import { type SyncResult, findListingsDueForSync, syncListing } from "@/server/sync/run";
import { SYNC_LISTING_JOB } from "../queues";

const syncListingDataSchema = z.object({ listingId: z.string().min(1) });

// The schedule job runs every ten minutes; within one such window a listing is queued at most once.
const SYNC_SCHEDULE_MINUTES = 10;

export async function syncOneListing(data: unknown): Promise<SyncResult> {
  const { listingId } = syncListingDataSchema.parse(data);
  return syncListing(listingId, await buildSyncDeps());
}

/** Queues a sync for every listing whose supplier data is older than its check interval. */
export async function scheduleSync(queue: Queue, now: Date = new Date()): Promise<{ queued: number }> {
  const due = await findListingsDueForSync(now, (await getSettings()).repricer);
  const window = Math.floor(now.getTime() / (SYNC_SCHEDULE_MINUTES * 60_000));
  await queue.addBulk(
    due.map((listingId) => ({
      name: SYNC_LISTING_JOB,
      data: { listingId },
      opts: { jobId: `${SYNC_LISTING_JOB}-${listingId}-${window}` },
    })),
  );
  return { queued: due.length };
}
