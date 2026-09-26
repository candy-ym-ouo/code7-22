import { createHash } from "node:crypto";
import type { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const MIGRATIONS_TABLE = "schema_migrations";
const MIGRATIONS_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "../migrations");

export type MigrationFile = {
  filename: string;
  sql: string;
  checksum: string;
  downFilename: string;
  downSql: string;
};

export type AppliedMigrationRow = {
  filename: string;
  checksum: string | null;
  applied_at: Date;
};

export type MigrationStatus = {
  filename: string;
  applied: boolean;
  appliedAt: Date | null;
  checksum: string | null;
  checksumMatches: boolean | null;
};

export function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

export function downFilenameFor(filename: string): string {
  return filename.replace(/\.sql$/, ".down.sql");
}

/** Read every up migration from the migrations directory plus its paired down file. */
export async function loadMigrations(directory: string = MIGRATIONS_DIRECTORY): Promise<MigrationFile[]> {
  const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
  const migrations: MigrationFile[] = [];
  for (const filename of files) {
    const sql = await readFile(join(directory, filename), "utf8");
    const downFilename = downFilenameFor(filename);
    const downSql = await readFile(join(directory, "down", downFilename), "utf8");
    migrations.push({
      filename,
      sql,
      checksum: checksum(sql),
      downFilename,
      downSql
    });
  }
  return migrations;
}

export async function ensureMigrationsTable(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      filename text PRIMARY KEY,
      checksum text NOT NULL DEFAULT '',
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  // Upgrade databases created by the pre-checksum runner without losing history.
  await client.query(`
    ALTER TABLE ${MIGRATIONS_TABLE}
      ADD COLUMN IF NOT EXISTS checksum text NOT NULL DEFAULT ''
  `);
}

async function appliedRows(client: Client): Promise<AppliedMigrationRow[]> {
  const result = await client.query<AppliedMigrationRow>(
    `SELECT filename, checksum, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY filename`
  );
  return result.rows;
}

export type VerifyResult = {
  upToDate: boolean;
  /** Applied rows whose SQL no longer matches the file on disk. */
  drifted: Array<{ filename: string; expected: string; actual: string | null }>;
  /** Files on disk that were never applied. */
  pending: string[];
  /** Rows in the database without a matching migration file (divergent history). */
  unknown: string[];
  status: MigrationStatus[];
};

/** Compare database migration state against the files shipped in this release. */
export async function verifyMigrations(
  client: Client,
  migrations?: MigrationFile[]
): Promise<VerifyResult> {
  await ensureMigrationsTable(client);
  const resolvedMigrations = migrations ?? (await loadMigrations());
  const rows = await appliedRows(client);
  const byFilename = new Map(rows.map((row) => [row.filename, row]));
  const knownFiles = new Set(resolvedMigrations.map((migration) => migration.filename));

  const drifted: VerifyResult["drifted"] = [];
  const pending: string[] = [];
  const unknown = rows.filter((row) => !knownFiles.has(row.filename)).map((row) => row.filename);
  const status: MigrationStatus[] = [];

  for (const migration of resolvedMigrations) {
    const row = byFilename.get(migration.filename);
    if (!row) {
      pending.push(migration.filename);
      status.push({
        filename: migration.filename,
        applied: false,
        appliedAt: null,
        checksum: null,
        checksumMatches: null
      });
      continue;
    }
    const storedChecksum = row.checksum || null;
    const checksumMatches = storedChecksum === null ? null : storedChecksum === migration.checksum;
    if (checksumMatches === false) {
      drifted.push({
        filename: migration.filename,
        expected: migration.checksum,
        actual: storedChecksum
      });
    }
    status.push({
      filename: migration.filename,
      applied: true,
      appliedAt: row.applied_at,
      checksum: storedChecksum,
      checksumMatches
    });
  }

  return { upToDate: drifted.length === 0 && pending.length === 0 && unknown.length === 0, drifted, pending, unknown, status };
}

export type MigrateOptions = {
  /** Refuse to run when already-applied migration files have drifted on disk. */
  allowDrift?: boolean;
  /** Migration directory (defaults to the package's migrations folder). */
  directory?: string;
  onApply?: (filename: string) => void;
};

/**
 * Apply every pending migration in filename order.
 *
 * Each migration runs in its own transaction: a failure rolls the partially
 * applied migration back immediately (PostgreSQL DDL is transactional), leaves
 * the database at the previous version, and surfaces a non-zero exit code so
 * the release can be rolled back instead of starting against a broken schema.
 */
export async function migrate(client: Client, options: MigrateOptions = {}): Promise<string[]> {
  await ensureMigrationsTable(client);
  const migrations = await loadMigrations(options.directory);
  const verification = await verifyMigrations(client, migrations);
  if (verification.drifted.length > 0 && !options.allowDrift) {
    throw new Error(
      [
        "Refusing to migrate: applied migrations differ from the files in this release:",
        ...verification.drifted.map((drift) => `  - ${drift.filename}`),
        "Investigate before deploying, or rerun with MIGRATE_ALLOW_DRIFT=true if this is intentional."
      ].join("\n")
    );
  }

  const applied: string[] = [];
  for (const migration of migrations) {
    const existing = await client.query(
      `SELECT 1 FROM ${MIGRATIONS_TABLE} WHERE filename = $1`,
      [migration.filename]
    );
    if (existing.rowCount) continue;

    await client.query("BEGIN");
    try {
      await client.query(migration.sql);
      await client.query(
        `INSERT INTO ${MIGRATIONS_TABLE}(filename, checksum) VALUES ($1, $2)`,
        [migration.filename, migration.checksum]
      );
      await client.query("COMMIT");
      applied.push(migration.filename);
      options.onApply?.(migration.filename);
    } catch (error) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${migration.filename} failed and was rolled back: ${(error as Error).message}`, {
        cause: error
      });
    }
  }
  return applied;
}

export type RollbackOptions = {
  /** Number of migrations to roll back, newest first. Defaults to 1. */
  steps?: number;
  /** Migration directory (defaults to the package's migrations folder). */
  directory?: string;
  onRollback?: (filename: string) => void;
};

/**
 * Roll back applied migrations in reverse order using the paired down/*.down.sql
 * file. Each rollback is transactional; a failed down migration keeps the
 * database at the current version instead of leaving it half-reverted.
 */
export async function rollback(client: Client, options: RollbackOptions = {}): Promise<string[]> {
  const steps = Math.max(1, options.steps ?? 1);
  await ensureMigrationsTable(client);
  const migrations = await loadMigrations(options.directory);
  const byFilename = new Map(migrations.map((migration) => [migration.filename, migration]));
  const rows = await appliedRows(client);
  const targets = rows.slice(-steps).reverse();

  const reverted: string[] = [];
  for (const row of targets) {
    const migration = byFilename.get(row.filename);
    if (!migration) {
      throw new Error(
        `Cannot roll back ${row.filename}: no matching migration file exists in this release.`
      );
    }
    await client.query("BEGIN");
    try {
      await client.query(migration.downSql);
      await client.query(`DELETE FROM ${MIGRATIONS_TABLE} WHERE filename = $1`, [migration.filename]);
      await client.query("COMMIT");
      reverted.push(migration.filename);
      options.onRollback?.(migration.filename);
    } catch (error) {
      await client.query("ROLLBACK");
      throw new Error(
        `Rollback of ${migration.filename} failed and was reverted: ${(error as Error).message}`,
        { cause: error }
      );
    }
  }
  return reverted;
}

/** Latest migration version the running application expects. */
export async function expectedVersion(directory?: string): Promise<string> {
  const migrations = await loadMigrations(directory);
  return migrations.at(-1)?.filename ?? "";
}

/** Version the database is actually at. */
export async function currentVersion(client: Client): Promise<string> {
  await ensureMigrationsTable(client);
  const result = await client.query<{ filename: string }>(
    `SELECT filename FROM ${MIGRATIONS_TABLE} ORDER BY filename DESC LIMIT 1`
  );
  return result.rows[0]?.filename ?? "";
}
