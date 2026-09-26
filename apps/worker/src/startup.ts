import { Client } from "pg";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import IORedis from "ioredis";
import { config } from "./config";
import { assertDatabaseVersion, waitForDatabase } from "@map/db/guard";
import { getPool } from "./db";
import type { Logger } from "@map/shared/logging";

/**
 * Worker startup gate. A worker must not consume jobs against the wrong schema
 * version or unreachable dependencies: jobs would only fail and exhaust
 * retries. Every probe uses a short-lived, bounded client; the persistent
 * pool/queue connections are only created afterwards.
 *   1. wait for PostgreSQL and verify the schema exactly matches the migration
 *      files shipped in this release;
 *   2. verify Redis answers PING;
 *   3. verify both S3 buckets (quarantine + public) are reachable.
 */
export async function runWorkerStartupChecks(logger: Logger): Promise<void> {
  logger.info("running worker startup checks");

  const pgClient = await waitForDatabase(
    async (attemptTimeoutMs) =>
      new Client({
        connectionString: config.DATABASE_URL,
        connectionTimeoutMillis: attemptTimeoutMs
      }),
    { connectTimeoutSeconds: config.DB_CONNECT_TIMEOUT_SECONDS }
  );
  try {
    const result = await assertDatabaseVersion(pgClient);
    logger.info({ current: result.current }, "database version verified");
  } finally {
    await pgClient.end();
  }

  const redis = new IORedis(config.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: () => null
  });
  try {
    await redis.connect();
    const redisReply = await redis.ping();
    if (redisReply !== "PONG") throw new Error(`Redis readiness failed: ${String(redisReply)}`);
    logger.info("redis ready");
  } finally {
    redis.disconnect();
  }

  const s3 = new S3Client({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY }
  });
  try {
    for (const bucket of [config.S3_QUARANTINE_BUCKET, config.S3_PUBLIC_BUCKET]) {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
      logger.info({ bucket }, "s3 bucket ready");
    }
  } finally {
    s3.destroy();
  }

  // Prove the persistent pool (used by jobs) also works.
  await getPool().query("SELECT 1");
  logger.info("worker startup checks passed");
}
