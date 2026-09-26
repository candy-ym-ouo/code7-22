import "@map/shared/bootstrap";
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { createLogger } from "@map/shared/logging";
import { config } from "./config";
import { getPool } from "./db";
import { runWorkerStartupChecks } from "./startup";
import { startWorkerHealthServer } from "./health-server";
import { processMediaJob, cleanupOriginalMedia, cleanupDeletedMediaObjects, markStaleFeatures, recoverStuckMedia, markUnreferencedMediaDeleted } from "./media-job";
import { dispatchOutbox, recoverStuckOutbox } from "./outbox";
import { purgeDeletedAccounts } from "./account-job";

const logger = createLogger({ app: "worker" });

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`Redis queue operation timed out after ${timeoutMs}ms`)), timeoutMs).unref();
    })
  ]);
}

async function main() {
  // Block all job consumption until schema version and every dependency
  // verifies. Uses short-lived probes, so a failed boot leaves no reconnecting
  // sockets behind and exits promptly.
  await runWorkerStartupChecks(logger);

  // Persistent connections are created only after a successful gate.
  const redisOptions = { maxRetriesPerRequest: null } as const;
  const queueConnection = new IORedis(config.REDIS_URL, redisOptions);
  const mediaWorkerConnection = new IORedis(config.REDIS_URL, redisOptions);
  const outboxWorkerConnection = new IORedis(config.REDIS_URL, redisOptions);

  for (const [name, connection] of [
    ["queue", queueConnection],
    ["media worker", mediaWorkerConnection],
    ["outbox worker", outboxWorkerConnection]
  ] as const) {
    connection.on("error", (error) => logger.error({ err: error, connection: name }, "Redis connection error"));
  }

  const ping = () => queueConnection.ping();
  const health = startWorkerHealthServer(ping, logger);

  const mediaQueue = new Queue("media", { connection: queueConnection });

  const mediaWorker = new Worker("media", async (job) => {
    if (job.name !== "process") return;
    await processMediaJob(String(job.data.mediaId));
  }, { connection: mediaWorkerConnection, concurrency: 2 });

  const outboxWorker = new Worker("outbox", async (job) => {
    if (job.name !== "dispatch") return;
    await dispatchOutbox(job.data?.eventId ? String(job.data.eventId) : undefined);
  }, { connection: outboxWorkerConnection, concurrency: 2 });

  mediaWorker.on("failed", (job, error) => logger.error({ jobId: job?.id, err: error }, "media job failed"));
  outboxWorker.on("failed", (job, error) => logger.error({ jobId: job?.id, err: error }, "outbox job failed"));

  let maintenanceRunning = false;

  async function maintenanceTick() {
    if (maintenanceRunning) return;
    maintenanceRunning = true;
    try {
      await recoverStuckOutbox();
      await dispatchOutbox();
      const stuckMedia = await recoverStuckMedia();
      for (const mediaId of stuckMedia) {
        await withTimeout(mediaQueue.add("process", { mediaId }, {
          jobId: `media-recover-${mediaId}-${Date.now()}`,
          removeOnComplete: 1000,
          removeOnFail: 1000
        }), 3_000);
      }
      await cleanupOriginalMedia();
      await markUnreferencedMediaDeleted();
      await cleanupDeletedMediaObjects();
      await markStaleFeatures();
      await purgeDeletedAccounts();
    } catch (error) {
      logger.error({ err: error }, "maintenance tick failed");
    } finally {
      maintenanceRunning = false;
    }
  }

  await maintenanceTick();
  const maintenanceTimer = setInterval(() => void maintenanceTick(), 60_000);
  maintenanceTimer.unref();

  logger.info("worker ready and consuming jobs");

  async function shutdown(signal: string) {
    logger.info({ signal }, "worker shutting down");
    clearInterval(maintenanceTimer);
    await Promise.all([mediaWorker.close(), outboxWorker.close(), mediaQueue.close()]);
    await health.close();
    for (const connection of [queueConnection, mediaWorkerConnection, outboxWorkerConnection]) {
      if (connection.status !== "end") connection.disconnect();
    }
    await getPool().end();
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  logger.error({ err: error }, "worker startup failed");
  process.exit(1);
});
