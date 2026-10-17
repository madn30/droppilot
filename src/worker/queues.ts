import { Queue } from "bullmq";
import type IORedis from "ioredis";

export const MAINTENANCE_QUEUE = "maintenance";
export const HEARTBEAT_JOB = "heartbeat";

export const MATCHING_QUEUE = "matching";
/** Re-runs matching for one variant. Data: { variantId }. */
export const MATCH_VARIANT_JOB = "match-variant";
/** Fans out one match-variant job per active variant. */
export const SCHEDULE_MATCHING_JOB = "schedule-matching";
/** Looks for competitor listings that appeared since the last matching run. */
export const WATCH_COMPETITORS_JOB = "watch-competitors";

export const SEASONAL_QUEUE = "seasonal";
/** Pauses, re-targets and discovers for holidays. */
export const SEASONAL_DAILY_JOB = "seasonal-daily";
/** Evaluates the supplier's trending products and lists the best ones. */
export const TRENDING_DISCOVERY_JOB = "trending-discovery";

export const SYNC_QUEUE = "sync";
/** Refreshes supplier price and stock for one listing and re-prices it. Data: { listingId }. */
export const SYNC_LISTING_JOB = "sync-listing";
/** Queues a sync-listing job for every listing that is due. */
export const SCHEDULE_SYNC_JOB = "schedule-sync";

export const ORDERS_QUEUE = "orders";
/** Fetches new marketplace orders and queues them. */
export const POLL_ORDERS_JOB = "poll-orders";
/** Places the supplier order for one marketplace order. Data: { orderId }. */
export const PROCESS_ORDER_JOB = "process-order";
/** Follows supplier shipments and uploads tracking numbers. */
export const UPDATE_TRACKING_JOB = "update-tracking";
/** Records account health and raises warnings. */
export const ACCOUNT_HEALTH_JOB = "account-health";

const HOUR_MS = 60 * 60 * 1000;
const TRACKING_INTERVAL_MS = 30 * 60 * 1000;
const SYNC_SCHEDULE_MS = 10 * 60 * 1000;
// Mondays at 03:00 UTC.
const WEEKLY_MATCHING_CRON = "0 3 * * 1";
// Every day at 02:00 UTC.
const WATCH_COMPETITORS_CRON = "0 2 * * *";
// Every day at 05:00 UTC.
const ACCOUNT_HEALTH_CRON = "0 5 * * *";
// Every day at 04:00 UTC.
const SEASONAL_DAILY_CRON = "0 4 * * *";
// Every day at 06:00 UTC.
const TRENDING_DISCOVERY_CRON = "0 6 * * *";

export interface Queues {
  maintenance: Queue;
  matching: Queue;
  seasonal: Queue;
  sync: Queue;
  orders: Queue;
}

// upsertJobScheduler is idempotent: restarting the worker never duplicates a schedule.
export async function registerSchedules(connection: IORedis, orderPollMinutes: number): Promise<Queues> {
  const maintenance = new Queue(MAINTENANCE_QUEUE, { connection });
  await maintenance.upsertJobScheduler(HEARTBEAT_JOB, { every: HOUR_MS }, { name: HEARTBEAT_JOB });

  const matching = new Queue(MATCHING_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 60_000 },
      removeOnComplete: 200,
      removeOnFail: 500,
    },
  });
  await matching.upsertJobScheduler(SCHEDULE_MATCHING_JOB, { pattern: WEEKLY_MATCHING_CRON }, { name: SCHEDULE_MATCHING_JOB });
  await matching.upsertJobScheduler(WATCH_COMPETITORS_JOB, { pattern: WATCH_COMPETITORS_CRON }, { name: WATCH_COMPETITORS_JOB });

  const seasonal = new Queue(SEASONAL_QUEUE, {
    connection,
    defaultJobOptions: { attempts: 2, backoff: { type: "exponential", delay: 300_000 }, removeOnComplete: 60, removeOnFail: 60 },
  });
  await seasonal.upsertJobScheduler(SEASONAL_DAILY_JOB, { pattern: SEASONAL_DAILY_CRON }, { name: SEASONAL_DAILY_JOB });
  await seasonal.upsertJobScheduler(TRENDING_DISCOVERY_JOB, { pattern: TRENDING_DISCOVERY_CRON }, { name: TRENDING_DISCOVERY_JOB });

  const sync = new Queue(SYNC_QUEUE, {
    connection,
    defaultJobOptions: { attempts: 3, backoff: { type: "exponential", delay: 30_000 }, removeOnComplete: 500, removeOnFail: 500 },
  });
  await sync.upsertJobScheduler(SCHEDULE_SYNC_JOB, { every: SYNC_SCHEDULE_MS }, { name: SCHEDULE_SYNC_JOB });

  const orders = new Queue(ORDERS_QUEUE, {
    connection,
    defaultJobOptions: { attempts: 5, backoff: { type: "exponential", delay: 60_000 }, removeOnComplete: 500, removeOnFail: 500 },
  });
  await orders.upsertJobScheduler(POLL_ORDERS_JOB, { every: orderPollMinutes * 60_000 }, { name: POLL_ORDERS_JOB });
  await orders.upsertJobScheduler(UPDATE_TRACKING_JOB, { every: TRACKING_INTERVAL_MS }, { name: UPDATE_TRACKING_JOB });
  await maintenance.upsertJobScheduler(ACCOUNT_HEALTH_JOB, { pattern: ACCOUNT_HEALTH_CRON }, { name: ACCOUNT_HEALTH_JOB });

  return { maintenance, matching, seasonal, sync, orders };
}
