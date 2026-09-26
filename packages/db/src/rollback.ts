import "@map/shared/bootstrap";
import { Client } from "pg";
import { createLogger } from "@map/shared";
import { dbConfig } from "./config";
import { rollback } from "./runner";

const logger = createLogger({ app: "db" });

function stepsFromArgs(): number {
  const stepsFlag = process.argv.find((arg) => arg.startsWith("--steps="));
  if (stepsFlag) {
    const value = Number(stepsFlag.slice("--steps=".length));
    if (!Number.isInteger(value) || value < 1) throw new Error("--steps must be a positive integer");
    return value;
  }
  return 1;
}

async function main() {
  const steps = stepsFromArgs();
  const client = new Client({ connectionString: dbConfig.DATABASE_URL });
  await client.connect();
  try {
    const reverted = await rollback(client, {
      steps,
      onRollback: (filename) => logger.info({ migration: filename }, "migration rolled back")
    });
    if (reverted.length === 0) {
      logger.warn("no migrations to roll back");
    } else {
      logger.info({ count: reverted.length }, "rollback complete");
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  logger.error({ err: error }, "rollback failed");
  process.exitCode = 1;
});
