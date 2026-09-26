import pg from "pg";
import { config } from "./config";
import { createLogger, logLevel } from "@map/shared/logger";

const logger = createLogger("worker", { level: logLevel(config.NODE_ENV, config.LOG_LEVEL) });

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 8,
  idleTimeoutMillis: 30_000
});

pool.on("error", (error) => {
  logger.error({ err: error }, "unexpected PostgreSQL pool error");
});
