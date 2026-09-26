import "@map/shared/bootstrap";
import { Client } from "pg";
import { createLogger } from "@map/shared";
import { dbConfig } from "./config";
import { currentVersion, expectedVersion, verifyMigrations } from "./runner";

const logger = createLogger({ app: "db" });

/**
 * Exit codes:
 *   0 - database matches the migration files in this release
 *   2 - database is behind, ahead or has drifted (startup must block)
 *   1 - could not connect or another error
 */
async function main() {
  const client = new Client({ connectionString: dbConfig.DATABASE_URL });
  await client.connect();
  try {
    const verification = await verifyMigrations(client);
    const [current, expected] = await Promise.all([currentVersion(client), expectedVersion()]);
    const report = {
      current,
      expected,
      pending: verification.pending,
      drifted: verification.drifted.map((drift) => drift.filename),
      unknown: verification.unknown
    };
    if (verification.upToDate) {
      logger.info(report, "database version matches release");
      return;
    }
    logger.error(report, "database version does not match release");
    process.exitCode = 2;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  logger.error({ err: error }, "status check failed");
  process.exitCode = 1;
});
