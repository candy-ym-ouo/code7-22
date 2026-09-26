import "@map/shared/bootstrap";
import { Client } from "pg";
import { createLogger } from "@map/shared";
import { dbConfig } from "./config";
import { migrate, verifyMigrations } from "./runner";

const logger = createLogger({ app: "db" });

async function main() {
  const client = new Client({ connectionString: dbConfig.DATABASE_URL });
  await client.connect();
  try {
    const applied = await migrate(client, {
      allowDrift: dbConfig.MIGRATE_ALLOW_DRIFT,
      onApply: (filename) => logger.info({ migration: filename }, "migration applied")
    });
    if (applied.length === 0) {
      logger.info("database already at latest version");
    }
    const verification = await verifyMigrations(client);
    logger.info({ pending: verification.pending.length, drifted: verification.drifted.length }, "migration complete");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  logger.error({ err: error }, "migration failed");
  process.exitCode = 1;
});
