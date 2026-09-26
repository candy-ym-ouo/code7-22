import { describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
import {
  checksum,
  downFilenameFor,
  ensureMigrationsTable,
  loadMigrations,
  migrate,
  rollback,
  verifyMigrations
} from "./runner";

type AppliedRow = { filename: string; checksum: string; applied_at: Date };

type FakeClientOptions = {
  applied?: AppliedRow[];
  /** Set of exact SELECT statements that return rows (besides the history query). */
  existingFilenames?: Set<string>;
  /** SQL fragments whose execution should fail. */
  failOnFragment?: string;
  failError?: Error;
};

/** In-memory pg Client that emulates the SQL the runner actually emits. */
function fakeClient(options: FakeClientOptions = {}) {
  const statements: string[] = [];
  const paramsLog: unknown[][] = [];

  const client = {
    query: vi.fn(async (text: string, params: unknown[] = []) => {
      statements.push(text);
      paramsLog.push(params);

      if (options.failOnFragment && text.includes(options.failOnFragment)) {
        throw options.failError ?? new Error("forced failure");
      }
      if (text === "SELECT filename, checksum, applied_at FROM schema_migrations ORDER BY filename") {
        return { rows: options.applied ?? [], rowCount: (options.applied ?? []).length };
      }
      if (text === "SELECT 1 FROM schema_migrations WHERE filename = $1") {
        const filename = String(params[0]);
        const exists = options.existingFilenames?.has(filename) ?? false;
        return { rows: exists ? [{ one: 1 }] : [], rowCount: exists ? 1 : 0 };
      }
      if (text.startsWith("SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1")) {
        const rows = [...(options.applied ?? [])].sort((a, b) => b.filename.localeCompare(a.filename)).slice(0, 1);
        return { rows: rows.map((row) => ({ filename: row.filename })), rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    })
  } as unknown as Client;

  return { client, statements, paramsLog };
}

describe("migration files on disk", () => {
  it("pairs every up migration with a down migration", async () => {
    const migrations = await loadMigrations();
    expect(migrations.length).toBeGreaterThanOrEqual(2);
    for (const migration of migrations) {
      expect(migration.downSql.length).toBeGreaterThan(0);
      expect(downFilenameFor(migration.filename)).toBe(migration.downFilename);
    }
    expect(migrations.map((m) => m.filename)).toEqual([...migrations.map((m) => m.filename)].sort());
  });

  it("checksums are stable, 64-char hex and unique", async () => {
    const migrations = await loadMigrations();
    for (const migration of migrations) {
      expect(migration.checksum).toBe(checksum(migration.sql));
      expect(migration.checksum).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(new Set(migrations.map((m) => m.checksum)).size).toBe(migrations.length);
  });

  it("the down migration for 0001 drops every table created up", async () => {
    const init = (await loadMigrations()).find((m) => m.filename === "0001_init.sql");
    expect(init).toBeDefined();
    for (const table of [
      "users", "sessions", "auth_tokens", "categories", "map_features",
      "feature_revisions", "media_assets", "revision_media", "comments",
      "feature_confirmations", "reports", "moderation_actions",
      "outbox_events", "audit_logs", "notifications"
    ]) {
      expect(init!.sql).toContain(`CREATE TABLE ${table}`);
      expect(init!.downSql).toContain(`DROP TABLE IF EXISTS ${table}`);
    }
  });

  it("0002 down reverses both added columns", async () => {
    const followup = (await loadMigrations()).find((m) => m.filename === "0002_media_public_thumb.sql");
    expect(followup!.downSql).toContain("DROP COLUMN IF EXISTS public_thumbnail_object_key");
    expect(followup!.downSql).toContain("DROP COLUMN IF EXISTS updated_at");
  });
});

describe("ensureMigrationsTable", () => {
  it("creates the tracking table and backfills the checksum column", async () => {
    const { client, statements } = fakeClient();
    await ensureMigrationsTable(client);
    expect(statements.some((sql) => sql.includes("CREATE TABLE IF NOT EXISTS schema_migrations"))).toBe(true);
    expect(statements.some((sql) => sql.includes("ADD COLUMN IF NOT EXISTS checksum"))).toBe(true);
  });
});

describe("migrate", () => {
  it("applies pending migrations in order inside transactions with checksums", async () => {
    const { client, statements, paramsLog } = fakeClient();
    const applied: string[] = [];
    const result = await migrate(client, { onApply: (filename) => applied.push(filename) });
    const migrations = await loadMigrations();

    expect(result).toEqual(migrations.map((m) => m.filename));
    expect(applied).toEqual(result);
    expect(statements.filter((sql) => sql === "BEGIN")).toHaveLength(migrations.length);
    expect(statements.filter((sql) => sql === "COMMIT")).toHaveLength(migrations.length);

    // The recorded checksum must equal the file checksum for each insert.
    const inserts = paramsLog.filter((params) => params.length === 2);
    expect(inserts).toHaveLength(migrations.length);
    for (const [index, params] of inserts.entries()) {
      expect(params[0]).toBe(migrations[index]!.filename);
      expect(params[1]).toBe(migrations[index]!.checksum);
    }

    const initIndex = statements.findIndex((sql) => sql.includes("CREATE TABLE users"));
    const thumbIndex = statements.findIndex((sql) => sql.includes("ADD COLUMN public_thumbnail_object_key"));
    expect(initIndex).toBeGreaterThanOrEqual(0);
    expect(thumbIndex).toBeGreaterThan(initIndex);
  });

  it("skips already applied migrations", async () => {
    const existing = new Set(["0001_init.sql", "0002_media_public_thumb.sql"]);
    const { client, statements } = fakeClient({ existingFilenames: existing });
    const result = await migrate(client);
    expect(result).toEqual([]);
    expect(statements).not.toContain("BEGIN");
  });

  it("rolls the failed migration back and stops with a wrapped error", async () => {
    const { client, statements } = fakeClient({
      failOnFragment: "CREATE TYPE user_role",
      failError: new Error("syntax error at end of input")
    });
    await expect(migrate(client)).rejects.toThrow(/0001_init\.sql failed and was rolled back/);
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
  });

  it("refuses to migrate when an applied file has drifted on disk", async () => {
    const { client } = fakeClient({
      applied: [{ filename: "0001_init.sql", checksum: "0".repeat(64), applied_at: new Date() }]
    });
    await expect(migrate(client)).rejects.toThrow(/Refusing to migrate/);
  });
});

describe("rollback", () => {
  it("reverts the latest migration using its down SQL and deletes the row", async () => {
    const migrations = await loadMigrations();
    const latest = migrations.at(-1)!;
    const { client, statements, paramsLog } = fakeClient({
      applied: migrations.map((m) => ({ filename: m.filename, checksum: m.checksum, applied_at: new Date() }))
    });
    const reverted = await rollback(client);
    expect(reverted).toEqual([latest.filename]);
    expect(statements.some((sql) => sql.includes("DROP COLUMN IF EXISTS public_thumbnail_object_key"))).toBe(true);
    expect(statements).toContain("BEGIN");
    expect(statements).toContain("COMMIT");
    expect(statements.some((sql) => sql.includes("DELETE FROM schema_migrations"))).toBe(true);
    expect(paramsLog.flat()).toContain(latest.filename);
  });

  it("rolls back multiple steps newest-first", async () => {
    const migrations = await loadMigrations();
    const { client } = fakeClient({
      applied: migrations.map((m) => ({ filename: m.filename, checksum: m.checksum, applied_at: new Date() }))
    });
    const reverted = await rollback(client, { steps: 2 });
    expect(reverted).toEqual([...migrations.map((m) => m.filename)].reverse().slice(0, 2));
  });

  it("reverts the transaction when the down SQL fails", async () => {
    const { client, statements } = fakeClient({
      applied: [{ filename: "0001_init.sql", checksum: "x", applied_at: new Date() }],
      failOnFragment: "DROP TABLE IF EXISTS notifications",
      failError: new Error("cannot drop type")
    });
    await expect(rollback(client)).rejects.toThrow(/Rollback of 0001_init\.sql failed/);
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
  });

  it("fails clearly when the database has a migration unknown to the release", async () => {
    const { client } = fakeClient({
      applied: [{ filename: "9999_ghost.sql", checksum: "x", applied_at: new Date() }]
    });
    await expect(rollback(client)).rejects.toThrow(/no matching migration file/);
  });
});

describe("verifyMigrations", () => {
  it("reports a clean database as up to date", async () => {
    const migrations = await loadMigrations();
    const { client } = fakeClient({
      applied: migrations.map((m) => ({ filename: m.filename, checksum: m.checksum, applied_at: new Date() }))
    });
    const result = await verifyMigrations(client);
    expect(result.upToDate).toBe(true);
    expect(result.pending).toEqual([]);
    expect(result.drifted).toEqual([]);
  });

  it("reports pending, drifted and unknown entries", async () => {
    const { client } = fakeClient({
      applied: [
        { filename: "0001_init.sql", checksum: "deadbeef", applied_at: new Date() },
        { filename: "9999_ghost.sql", checksum: "abcd", applied_at: new Date() }
      ]
    });
    const result = await verifyMigrations(client);
    expect(result.upToDate).toBe(false);
    expect(result.drifted.map((d) => d.filename)).toContain("0001_init.sql");
    expect(result.unknown).toContain("9999_ghost.sql");
    expect(result.pending).toContain("0002_media_public_thumb.sql");
  });
});
