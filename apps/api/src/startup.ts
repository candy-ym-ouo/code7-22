import IORedis from "ioredis";
import { Client } from "pg";
import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { S3Client } from "@aws-sdk/client-s3";
import { config } from "./config";
import { assertDatabaseVersion, waitForDatabase } from "@map/db/guard";
import type { Logger } from "@map/shared/logging";

/**
 * Startup gate executed before the HTTP server accepts traffic. Every check
 * uses a short-lived, bounded client so a missing dependency cannot start an
 * endless reconnection loop or keep the process alive on failure:
 *   1. wait for PostgreSQL (tolerates container start order), then verify the
 *      deployed code and schema are the exact same version (checksum drift,
 *      pending or unknown migrations abort startup);
 *   2. verify the JWT signing key is present and not a development placeholder;
 *   3. verify Redis answers PING (lazy client, single attempt);
 *   4. verify both S3 buckets exist.
 */
export async function runStartupChecks(logger: Logger): Promise<void> {
  logger.info("running startup checks");

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

  if (config.JWT_ACCESS_SECRET.length < 16) {
    throw new Error("JWT_ACCESS_SECRET is too short to sign access tokens");
  }
  if (config.NODE_ENV === "production" && /development-only/.test(config.JWT_ACCESS_SECRET)) {
    throw new Error("Refusing to start with the development JWT_ACCESS_SECRET in production");
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

  logger.info("startup checks passed");
}
