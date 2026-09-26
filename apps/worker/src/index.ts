import { createLogger, logLevel } from "@map/shared/logger";
import type { HealthChecks } from "./health";

// 入口只静态引入 logger：配置校验失败时也能输出结构化 JSON 日志而不是裸堆栈。
const bootLogger = createLogger("worker");

async function main() {
  const { config } = await import("./config");
  const logger = createLogger("worker", { level: logLevel(config.NODE_ENV, config.LOG_LEVEL) });

  const { pool } = await import("./db");
  const { assertDatabaseVersion } = await import("@map/db/version");
  const { processMediaJob, cleanupOriginalMedia, cleanupDeletedMediaObjects, markStaleFeatures, recoverStuckMedia, markUnreferencedMediaDeleted } = await import("./media-job");
  const { dispatchOutbox, recoverStuckOutbox } = await import("./outbox");
  const { purgeDeletedAccounts } = await import("./account-job");
  const { startHealthServer } = await import("./health");
  const { Queue, Worker } = await import("bullmq");
  const { default: IORedis } = await import("ioredis");

  // 启动校验：配置已在 config.ts 校验（生产禁止关闭 ClamAV）；
  // 这里确认数据库迁移版本与代码一致，避免新旧代码混跑。
  logger.info("checking database schema version before startup");
  await assertDatabaseVersion(pool);
  logger.info("database schema version matches code");

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

  async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`Redis queue operation timed out after ${timeoutMs}ms`)), timeoutMs).unref();
      })
    ]);
  }

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

  async function checkReady(): Promise<HealthChecks> {
    const checks: HealthChecks = { database: "ok", migrations: "ok", redis: "ok" };
    try {
      await pool.query("SELECT 1");
    } catch {
      checks.database = "fail";
      checks.migrations = "skipped";
    }
    if (checks.database === "ok") {
      try {
        await assertDatabaseVersion(pool);
      } catch {
        checks.migrations = "fail";
      }
    }
    try {
      const reply = await withTimeout(queueConnection.ping(), 2_000);
      if (reply !== "PONG") checks.redis = "fail";
    } catch {
      checks.redis = "fail";
    }
    return checks;
  }

  const healthServer = startHealthServer({ port: config.WORKER_HEALTH_PORT, logger, checkReady });

  await maintenanceTick();
  const maintenanceTimer = setInterval(() => void maintenanceTick(), 60_000);
  maintenanceTimer.unref();
  logger.info("worker started");

  async function shutdown(signal: string) {
    logger.info({ signal }, "worker shutting down");
    clearInterval(maintenanceTimer);
    healthServer.close();
    await Promise.all([mediaWorker.close(), outboxWorker.close(), mediaQueue.close()]);
    for (const connection of [queueConnection, mediaWorkerConnection, outboxWorkerConnection]) {
      if (connection.status !== "end") connection.disconnect();
    }
    await pool.end();
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  bootLogger.error({ err: error }, "worker startup aborted");
  process.exit(1);
});
