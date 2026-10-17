import type { Prisma } from "@prisma/client";
import { db } from "@/server/db";
import { logger } from "@/server/logger";

interface JobIdentity {
  queue: string;
  jobName: string;
  jobKey?: string;
}

/** Runs a job and records its outcome in JobLog. Errors are rethrown so BullMQ can retry. */
export async function withJobLog<T extends Prisma.InputJsonValue>(
  identity: JobIdentity,
  run: () => Promise<T>,
): Promise<T> {
  const log = await db.jobLog.create({ data: { ...identity, status: "RUNNING" } });
  try {
    const result = await run();
    await db.jobLog.update({
      where: { id: log.id },
      data: { status: "SUCCEEDED", result, finishedAt: new Date() },
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    logger.error({ ...identity, err: error }, "job failed");
    await db.jobLog.update({
      where: { id: log.id },
      data: { status: "FAILED", error: message, finishedAt: new Date() },
    });
    throw error;
  }
}
