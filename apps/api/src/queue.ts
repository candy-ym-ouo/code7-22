import { Queue } from "bullmq";
import IORedis from "ioredis";
import { config } from "./config";
import { createLogger, logLevel } from "@map/shared/logger";

const logger = createLogger("api", { level: logLevel(config.NODE_ENV, config.LOG_LEVEL) });

const redisOptions = { maxRetriesPerRequest: null } as const;
export const mediaRedis = new IORedis(config.REDIS_URL, redisOptions);
export const outboxRedis = new IORedis(config.REDIS_URL, redisOptions);
mediaRedis.on("error", (error) => logger.error({ err: error }, "media Redis connection error"));
outboxRedis.on("error", (error) => logger.error({ err: error }, "outbox Redis connection error"));

export const mediaQueue = new Queue("media", { connection: mediaRedis });
export const outboxQueue = new Queue("outbox", { connection: outboxRedis });

/** 就绪检查使用：任一队列连接可 ping 通即视为 Redis 可用。 */
export async function pingRedis(timeoutMs = 2_000): Promise<boolean> {
  try {
    return await Promise.race([
      mediaRedis.ping().then((reply) => reply === "PONG"),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs).unref())
    ]);
  } catch {
    return false;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`Redis queue operation timed out after ${timeoutMs}ms`)), timeoutMs).unref();
    })
  ]);
}

export async function enqueueMediaProcessing(mediaId: string, jobId: string): Promise<void> {
  await withTimeout(
    mediaQueue.add("process", { mediaId }, {
      jobId,
      removeOnComplete: 1000,
      removeOnFail: 1000
    }),
    3_000
  );
}

export async function enqueueOutbox(eventId: string): Promise<void> {
  try {
    await withTimeout(
      outboxQueue.add("dispatch", { eventId }, { removeOnComplete: 1000, removeOnFail: 1000 }),
      3_000
    );
  } catch (error) {
    // The database outbox remains the source of truth. A worker maintenance tick retries pending rows.
    logger.error({ eventId, err: error }, "failed to enqueue outbox event");
  }
}

export async function closeQueues(): Promise<void> {
  await Promise.all([mediaQueue.close(), outboxQueue.close()]);
  if (mediaRedis.status !== "end") mediaRedis.disconnect();
  if (outboxRedis.status !== "end") outboxRedis.disconnect();
}
