import { type Job, Worker } from "bullmq";
import { getNotifiers } from "@/server/alerts/notifiers";
import { raiseAlert } from "@/server/alerts/service";
import { db } from "@/server/db";
import { getEnv } from "@/server/env";
import { logger } from "@/server/logger";
import { createRedisConnection } from "@/server/redis";
import { buildListingDeps } from "@/server/listing/deps";
import { buildOrderDeps } from "@/server/orders/deps";
import { getSettings } from "@/server/settings/service";
import { TelegramApi, parseTelegramWebhook } from "@/server/telegram/api";
import { runCommand } from "@/server/telegram/commands";
import { listenForCommands } from "@/server/telegram/listener";
import { withJobLog } from "./job-log";
import { heartbeat } from "./jobs/heartbeat";
import { matchVariant, scheduleMatching, watchCompetitors } from "./jobs/matching";
import { checkAccountHealth, pollAllOrders, processOneOrder, trackOrders } from "./jobs/orders";
import { seasonalDaily, trendingDiscovery } from "./jobs/seasonal";
import { scheduleSync, syncOneListing } from "./jobs/sync";
import {
  ACCOUNT_HEALTH_JOB,
  HEARTBEAT_JOB,
  MAINTENANCE_QUEUE,
  MATCHING_QUEUE,
  MATCH_VARIANT_JOB,
  ORDERS_QUEUE,
  POLL_ORDERS_JOB,
  PROCESS_ORDER_JOB,
  SCHEDULE_MATCHING_JOB,
  SCHEDULE_SYNC_JOB,
  SEASONAL_DAILY_JOB,
  SEASONAL_QUEUE,
  SYNC_LISTING_JOB,
  SYNC_QUEUE,
  TRENDING_DISCOVERY_JOB,
  UPDATE_TRACKING_JOB,
  WATCH_COMPETITORS_JOB,
  registerSchedules,
} from "./queues";

async function main(): Promise<void> {
  const env = getEnv();
  const connection = createRedisConnection();
  const queues = await registerSchedules(connection, (await getSettings()).orders.pollIntervalMinutes);

  const maintenanceWorker = new Worker(
    MAINTENANCE_QUEUE,
    async (job: Job) => {
      switch (job.name) {
        case HEARTBEAT_JOB:
          return withJobLog({ queue: MAINTENANCE_QUEUE, jobName: job.name, jobKey: job.id }, () =>
            heartbeat(connection),
          );
        case ACCOUNT_HEALTH_JOB:
          return withJobLog({ queue: MAINTENANCE_QUEUE, jobName: job.name, jobKey: job.id }, checkAccountHealth);
        default:
          throw new Error(`No handler for job "${job.name}" on queue "${MAINTENANCE_QUEUE}"`);
      }
    },
    { connection },
  );

  // Matching calls rate-limited APIs, so variants are processed one at a time.
  const matchingWorker = new Worker(
    MATCHING_QUEUE,
    async (job: Job) => {
      const identity = { queue: MATCHING_QUEUE, jobName: job.name, jobKey: job.id };
      switch (job.name) {
        case MATCH_VARIANT_JOB:
          return withJobLog(identity, async () => ({ ...(await matchVariant(job.data)) }));
        case SCHEDULE_MATCHING_JOB:
          return withJobLog(identity, () => scheduleMatching(queues.matching));
        case WATCH_COMPETITORS_JOB:
          return withJobLog(identity, () => watchCompetitors(queues.matching));
        default:
          throw new Error(`No handler for job "${job.name}" on queue "${MATCHING_QUEUE}"`);
      }
    },
    { connection, concurrency: 1 },
  );

  const seasonalWorker = new Worker(
    SEASONAL_QUEUE,
    async (job: Job) => {
      switch (job.name) {
        case SEASONAL_DAILY_JOB:
          return withJobLog({ queue: SEASONAL_QUEUE, jobName: job.name, jobKey: job.id }, seasonalDaily);
        case TRENDING_DISCOVERY_JOB:
          return withJobLog({ queue: SEASONAL_QUEUE, jobName: job.name, jobKey: job.id }, trendingDiscovery);
        default:
          throw new Error(`No handler for job "${job.name}" on queue "${SEASONAL_QUEUE}"`);
      }
    },
    { connection, concurrency: 1 },
  );

  const syncWorker = new Worker(
    SYNC_QUEUE,
    async (job: Job) => {
      const identity = { queue: SYNC_QUEUE, jobName: job.name, jobKey: job.id };
      switch (job.name) {
        case SYNC_LISTING_JOB:
          return withJobLog(identity, async () => ({ ...(await syncOneListing(job.data)) }));
        case SCHEDULE_SYNC_JOB:
          // Runs every ten minutes; only its failures are worth a log row.
          return scheduleSync(queues.sync);
        default:
          throw new Error(`No handler for job "${job.name}" on queue "${SYNC_QUEUE}"`);
      }
    },
    { connection, concurrency: 1 },
  );

  // One order at a time: each one talks to the rate-limited supplier API.
  const ordersWorker = new Worker(
    ORDERS_QUEUE,
    async (job: Job) => {
      const identity = { queue: ORDERS_QUEUE, jobName: job.name, jobKey: job.id };
      switch (job.name) {
        case POLL_ORDERS_JOB:
          // Runs every few minutes; a log row per run would be noise, its failures are logged by the worker.
          return pollAllOrders(queues.orders);
        case PROCESS_ORDER_JOB:
          return withJobLog(identity, async () => ({ ...(await processOneOrder(job.data)) }));
        case UPDATE_TRACKING_JOB:
          return withJobLog(identity, async () => ({ ...(await trackOrders()) }));
        default:
          throw new Error(`No handler for job "${job.name}" on queue "${ORDERS_QUEUE}"`);
      }
    },
    { connection, concurrency: 1 },
  );

  const workers = [maintenanceWorker, matchingWorker, seasonalWorker, syncWorker, ordersWorker];
  for (const worker of workers) {
    worker.on("failed", (job, error) => {
      logger.error({ queue: worker.name, job: job?.name, err: error }, "job failed");
      // Once the retries are used up nobody would notice: put it in front of the admin.
      if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
      void raiseAlert(
        {
          severity: "WARNING",
          type: `job.failed.${worker.name}.${job.name}`,
          title: `Background job "${job.name}" keeps failing`,
          message: `${error.message}\nIt failed ${job.attemptsMade} time(s) on the "${worker.name}" queue and will not be retried until its next scheduled run.`,
        },
        getNotifiers(),
      ).catch((alertError: unknown) => {
        logger.error({ err: alertError }, "could not raise the job failure alert");
      });
    });
  }

  logger.info({ mockApis: env.MOCK_APIS, queues: workers.map((worker) => worker.name) }, "worker started");

  let shuttingDown = false;

  // The admin can answer alerts and send commands in the Telegram chat the alerts go to.
  const telegram = env.MOCK_APIS || !env.TELEGRAM_WEBHOOK_URL ? null : parseTelegramWebhook(env.TELEGRAM_WEBHOOK_URL);
  if (telegram) {
    const commandDeps = { listing: buildListingDeps, orders: buildOrderDeps };
    void listenForCommands(new TelegramApi(telegram.token, telegram.chatId), (command) => runCommand(command, commandDeps), () => shuttingDown);
    logger.info("listening for telegram commands");
  }

  const shutdown = async (signal: string): Promise<void> => {
    // A second signal while closing must not close the connections twice.
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "worker shutting down");
    await Promise.all(workers.map((worker) => worker.close()));
    await Promise.all(Object.values(queues).map((queue) => queue.close()));
    await connection.quit();
    await db.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, "worker failed to start");
  process.exit(1);
});
