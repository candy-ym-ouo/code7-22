import pg from "pg";
import type { PoolClient, QueryResultRow } from "pg";
import { config } from "./config";
import { createLogger } from "@map/shared/logging";

const { Pool } = pg;

const logger = createLogger({ app: "api" });

let poolInstance: pg.Pool | undefined;

/** Lazily create the connection pool after startup checks pass. */
export function getPool(): pg.Pool {
  if (!poolInstance) {
    poolInstance = new Pool({
      connectionString: config.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30_000
    });
    poolInstance.on("error", (error) => {
      logger.error({ err: error }, "unexpected PostgreSQL pool error");
    });
  }
  return poolInstance;
}

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) {
  return getPool().query<T>(text, values);
}

export async function transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = getPool();
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
