import { Queue } from "bullmq";
import IORedis, { type Redis } from "ioredis";
import { config } from "./config";
import { createLogger } from "@map/shared/logging";

const logger = createLogger({ app: "api" });

const redisOptions = { maxRetriesPerRequest: null } as const;

let mediaRedis: Redis | undefined;
let outboxRedis: Redis | undefined;
let mediaQueue: Queue | undefined;
let outboxQueue: Queue | undefined;

/**
 * Lazily create and connect the BullMQ connections. Called only after startup
 * checks pass, so an unreachable Redis during boot cannot create a reconnect
 * storm or pin the process open after a failed start.
 */
export function connectQueues(): { mediaRedis: Redis; outboxRedis: Redis } {
  if (mediaRedis && outboxRedis) return { mediaRedis, outboxRedis };
  mediaRedis = new IORedis(config.REDIS_URL, redisOptions);
  outboxRedis = new IORedis(config.REDIS_URL, redisOptions);
  mediaRedis.on("error", (error) => logger.error({ err: error }, "media Redis connection error"));
  outboxRedis.on("error", (error) => logger.error({ err: error }, "outbox Redis connection error"));
  mediaQueue = new Queue("media", { connection: mediaRedis });
  outboxQueue = new Queue("outbox", { connection: outboxRedis });
  return { mediaRedis, outboxRedis };
}

export function getMediaRedis(): Redis {
  if (!mediaRedis) throw new Error("Queues are not connected; call connectQueues() after startup checks");
  return mediaRedis;
}

function getMediaQueue(): Queue {
  if (!mediaQueue) throw new Error("Queues are not connected; call connectQueues() after startup checks");
  return mediaQueue;
}

function getOutboxQueue(): Queue {
  if (!outboxQueue) throw new Error("Queues are not connected; call connectQueues() after startup checks");
  return outboxQueue;
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
    getMediaQueue().add("process", { mediaId }, {
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
      getOutboxQueue().add("dispatch", { eventId }, { removeOnComplete: 1000, removeOnFail: 1000 }),
      3_000
    );
  } catch (error) {
    // The database outbox remains the source of truth. A worker maintenance tick retries pending rows.
    logger.error({ eventId, err: error }, "failed to enqueue outbox event");
  }
}

export async function closeQueues(): Promise<void> {
  await Promise.all([mediaQueue?.close(), outboxQueue?.close()]);
  if (mediaRedis && mediaRedis.status !== "end") mediaRedis.disconnect();
  if (outboxRedis && outboxRedis.status !== "end") outboxRedis.disconnect();
}
