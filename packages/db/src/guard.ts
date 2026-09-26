import type { Client, Pool } from "pg";
import {
  currentVersion,
  expectedVersion,
  verifyMigrations,
  type MigrationFile,
  type VerifyResult
} from "./runner";

export type DatabaseGuardOptions = {
  /** Seconds to wait for PostgreSQL to accept connections (e.g. container start order). */
  connectTimeoutSeconds?: number;
  /** Seconds between connection attempts. */
  retryDelaySeconds?: number;
};

export type DatabaseGuardResult = {
  current: string;
  expected: string;
  verification: VerifyResult;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for PostgreSQL to accept a connection. Returns successfully as soon as
 * `SELECT 1` works; throws after the timeout so the process exits instead of
 * starting in a degraded state.
 */
export async function waitForDatabase(
  createConnection: (attemptTimeoutMs: number) => Promise<Client>,
  options: DatabaseGuardOptions = {}
): Promise<Client> {
  const timeoutMs = (options.connectTimeoutSeconds ?? 30) * 1000;
  const delayMs = (options.retryDelaySeconds ?? 1) * 1000;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    // Bound each individual connect/query attempt so a black-holed host
    // cannot hang the retry loop beyond the overall deadline.
    const attemptTimeoutMs = Math.min(5_000, deadline - Date.now());
    const client = await createConnection(attemptTimeoutMs);
    try {
      // A standalone pg Client does not auto-connect; connect explicitly then ping.
      await client.connect();
      await client.query("SELECT 1");
      return client;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      if (Date.now() >= deadline) break;
      await sleep(delayMs);
    }
  }
  throw new Error(`Database did not become ready within ${timeoutMs / 1000}s`, { cause: lastError });
}

/**
 * Startup gate shared by API and worker.
 *
 * 1. Confirms the database is reachable.
 * 2. Confirms every applied migration matches the file shipped in this
 *    release (checksum drift blocks startup).
 * 3. Confirms there are no pending or unknown migrations, i.e. the deployed
 *    code and the database schema are exactly the same version.
 *
 * Any mismatch exits the process before it binds a port or consumes jobs.
 */
export async function assertDatabaseVersion(
  client: Client | Pool,
  options: { migrations?: MigrationFile[] } = {}
): Promise<DatabaseGuardResult> {
  const verification = await verifyMigrations(client as Client, options.migrations);
  const [current, expected] = await Promise.all([
    currentVersion(client as Client),
    options.migrations
      ? Promise.resolve(options.migrations.at(-1)?.filename ?? "")
      : expectedVersion()
  ]);

  const problems: string[] = [];
  if (verification.drifted.length > 0) {
    problems.push(
      `migrated files have changed on disk: ${verification.drifted.map((d) => d.filename).join(", ")}`
    );
  }
  if (verification.pending.length > 0) {
    problems.push(
      `database is behind the application (pending: ${verification.pending.join(", ")}); run db:migrate`
    );
  }
  if (verification.unknown.length > 0) {
    problems.push(
      `database contains migrations unknown to this release: ${verification.unknown.join(", ")}`
    );
  }
  if (problems.length > 0) {
    throw new Error(
      ["Database version verification failed, refusing to start:", ...problems.map((p) => `  - ${p}`)].join("\n")
    );
  }
  if (current !== expected) {
    throw new Error(`Database version mismatch: database=${current} release=${expected}`);
  }
  return { current, expected, verification };
}
