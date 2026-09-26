import pg from "pg";
import { config } from "./config";
import { createLogger } from "@map/shared/logging";

const { Pool } = pg;

const logger = createLogger({ app: "worker" });

let poolInstance: pg.Pool | undefined;

/** Lazily create the connection pool after startup checks pass. */
export function getPool(): pg.Pool {
  if (!poolInstance) {
    poolInstance = new Pool({
      connectionString: config.DATABASE_URL,
      max: 8,
      idleTimeoutMillis: 30_000
    });
    poolInstance.on("error", (error) => {
      logger.error({ err: error }, "unexpected PostgreSQL pool error");
    });
  }
  return poolInstance;
}
