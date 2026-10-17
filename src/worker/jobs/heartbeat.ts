import type IORedis from "ioredis";
import { db } from "@/server/db";
import { getEnv } from "@/server/env";

/** Proves the worker can reach Postgres and Redis; the dashboard shows the last run. */
export async function heartbeat(redis: IORedis): Promise<{ mockApis: boolean; redis: string }> {
  await db.$queryRaw`SELECT 1`;
  return { mockApis: getEnv().MOCK_APIS, redis: await redis.ping() };
}
