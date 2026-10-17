import IORedis from "ioredis";
import { getEnv } from "./env";

// BullMQ requires maxRetriesPerRequest: null on connections used by workers.
export function createRedisConnection(): IORedis {
  return new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
}
