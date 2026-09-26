import pg from "pg";
import type { PoolClient, QueryResultRow } from "pg";
import { config } from "./config";
import { createLogger, logLevel } from "@map/shared/logger";

const logger = createLogger("api", { level: logLevel(config.NODE_ENV, config.LOG_LEVEL) });

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000
});

pool.on("error", (error) => {
  logger.error({ err: error }, "unexpected PostgreSQL pool error");
});

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) {
  return pool.query<T>(text, values);
}

export async function transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function json(value: unknown): string {
  return JSON.stringify(value);
}
