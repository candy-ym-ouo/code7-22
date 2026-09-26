import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOWN_MARKER, loadMigrations, migrationChecksum, splitMigration } from "./migrations";
import { assertDatabaseVersion, checkDatabaseVersion } from "./version";
import type { AppliedMigration, Queryable } from "./version";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../migrations");
const migration = readFileSync(join(migrationsDir, "0001_init.sql"), "utf8");

describe("initial migration", () => {
  it("contains the core audited entities", () => {
    for (const table of [
      "users", "sessions", "auth_tokens", "categories", "map_features",
      "feature_revisions", "media_assets", "comments", "reports",
      "moderation_actions", "outbox_events", "audit_logs", "notifications"
    ]) {
      expect(migration).toContain(`CREATE TABLE ${table}`);
    }
  });

  it("adds public thumbnail and outbox recovery fields in migration 0002", () => {
    const followup = readFileSync(join(migrationsDir, "0002_media_public_thumb.sql"), "utf8");
    expect(followup).toContain("public_thumbnail_object_key");
    expect(followup).toContain("updated_at timestamptz");
  });

  it("uses PostGIS geography points and spatial indexes", () => {
    expect(migration).toContain("geography(Point, 4326)");
    expect(migration).toContain("USING gist (geom)");
  });
});

describe("migration file format", () => {
  it("splits up and down sections at the marker", () => {
    const sql = "CREATE TABLE a(id int);\n\n-- migrate:down\nDROP TABLE a;\n";
    const { up, down } = splitMigration(sql);
    expect(up).toContain("CREATE TABLE a");
    expect(up).not.toContain("DROP TABLE");
    expect(down).toContain("DROP TABLE a");
  });

  it("treats files without a marker as non-reversible", () => {
    const { up, down } = splitMigration("SELECT 1;\n");
    expect(up).toBe("SELECT 1;\n");
    expect(down).toBeNull();
  });

  it("treats an empty down section as non-reversible", () => {
    const { down } = splitMigration(`SELECT 1;\n${DOWN_MARKER}\n`);
    expect(down).toBeNull();
  });

  it("checksum only covers the up section", () => {
    const base = "SELECT 1;";
    const withDown = `${base}\n${DOWN_MARKER}\nSELECT 2;`;
    expect(migrationChecksum(splitMigration(withDown).up)).toBe(migrationChecksum(base));
  });
});

describe("migration directory", () => {
  it("loads migrations in filename order with stable checksums", async () => {
    const migrations = await loadMigrations(migrationsDir);
    expect(migrations.map((m) => m.filename)).toEqual([
      "0001_init.sql",
      "0002_media_public_thumb.sql"
    ]);
    const again = await loadMigrations(migrationsDir);
    expect(again.map((m) => m.checksum)).toEqual(migrations.map((m) => m.checksum));
  });

  it("requires every migration to be reversible", async () => {
    const migrations = await loadMigrations(migrationsDir);
    for (const item of migrations) {
      expect(item.down, `${item.filename} 缺少 ${DOWN_MARKER} 回滚段`).toBeTruthy();
    }
  });
});

function fakeClient(rows: AppliedMigration[]): Queryable {
  return {
    async query<T>(text: string) {
      if (text.includes("FROM schema_migrations")) {
        return { rows: rows as unknown as T[], rowCount: rows.length };
      }
      throw new Error(`unexpected query: ${text}`);
    }
  };
}

const expected = [
  { filename: "0001_a.sql", up: "SELECT 1;", down: "SELECT 2;", checksum: migrationChecksum("SELECT 1;") },
  { filename: "0002_b.sql", up: "SELECT 3;", down: "SELECT 4;", checksum: migrationChecksum("SELECT 3;") }
];

describe("database version check", () => {
  it("passes when applied migrations match the code", async () => {
    const client = fakeClient([
      { filename: "0001_a.sql", checksum: expected[0]!.checksum, applied_at: "2026-01-01" },
      { filename: "0002_b.sql", checksum: expected[1]!.checksum, applied_at: "2026-01-02" }
    ]);
    const report = await checkDatabaseVersion(client, expected);
    expect(report.ok).toBe(true);
    await expect(assertDatabaseVersion(client, expected)).resolves.toBeUndefined();
  });

  it("reports pending migrations", async () => {
    const client = fakeClient([
      { filename: "0001_a.sql", checksum: expected[0]!.checksum, applied_at: "2026-01-01" }
    ]);
    const report = await checkDatabaseVersion(client, expected);
    expect(report.ok).toBe(false);
    expect(report.pending).toEqual(["0002_b.sql"]);
    await expect(assertDatabaseVersion(client, expected)).rejects.toThrow(/0002_b\.sql/);
  });

  it("refuses to start when the database is newer than the code", async () => {
    const client = fakeClient([
      { filename: "0001_a.sql", checksum: expected[0]!.checksum, applied_at: "2026-01-01" },
      { filename: "0002_b.sql", checksum: expected[1]!.checksum, applied_at: "2026-01-02" },
      { filename: "0003_future.sql", checksum: "abc", applied_at: "2026-01-03" }
    ]);
    const report = await checkDatabaseVersion(client, expected);
    expect(report.ok).toBe(false);
    expect(report.unexpected).toEqual(["0003_future.sql"]);
  });

  it("detects drifted migration files", async () => {
    const client = fakeClient([
      { filename: "0001_a.sql", checksum: "tampered", applied_at: "2026-01-01" },
      { filename: "0002_b.sql", checksum: expected[1]!.checksum, applied_at: "2026-01-02" }
    ]);
    const report = await checkDatabaseVersion(client, expected);
    expect(report.ok).toBe(false);
    expect(report.drifted).toEqual(["0001_a.sql"]);
  });

  it("tolerates legacy rows without checksums", async () => {
    const client = fakeClient([
      { filename: "0001_a.sql", checksum: null, applied_at: "2026-01-01" },
      { filename: "0002_b.sql", checksum: expected[1]!.checksum, applied_at: "2026-01-02" }
    ]);
    const report = await checkDatabaseVersion(client, expected);
    expect(report.ok).toBe(true);
    expect(report.unchecksummed).toEqual(["0001_a.sql"]);
  });
});
