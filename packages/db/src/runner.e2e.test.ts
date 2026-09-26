import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import EmbeddedPostgres from "embedded-postgres";
import { assertDatabaseVersion } from "./guard";
import { currentVersion, migrate, rollback, verifyMigrations, loadMigrations } from "./runner";

// The embedded binaries ship their ICU/openssl libraries in native/lib.
// Point the dynamic loader there before any postgres child process spawns.
const requireFromDb = createRequire(import.meta.url);
function embeddedNativeLib(): string {
  // Resolves to node_modules/@embedded-postgres/linux-<arch>/native/... on linux.
  const candidates = [
    "@embedded-postgres/linux-arm64",
    "@embedded-postgres/linux-x64"
  ];
  for (const candidate of candidates) {
    try {
      const pkgPath = requireFromDb.resolve(`${candidate}/package.json`);
      return join(dirname(pkgPath), "native", "lib");
    } catch {
      // try next platform package
    }
  }
  return "";
}
{
  const libDir = embeddedNativeLib();
  if (libDir) {
    process.env.LD_LIBRARY_PATH = [libDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
  }
}

/** Pick a free TCP port for the embedded cluster. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

const MIGRATION_0001 = `CREATE TABLE items (id integer PRIMARY KEY)`;
const DOWN_0001 = `DROP TABLE IF EXISTS items`;
const MIGRATION_0002 = `ALTER TABLE items ADD COLUMN name text`;
const DOWN_0002 = `ALTER TABLE items DROP COLUMN IF EXISTS name`;
const MIGRATION_0003 = `CREATE TABLE extra (id integer PRIMARY KEY)`;
const DOWN_0003 = `DROP TABLE IF EXISTS extra`;

async function writeMigrationSet(dir: string, files: Record<string, { up: string; down: string }>): Promise<void> {
  await mkdir(join(dir, "down"), { recursive: true });
  for (const [name, pair] of Object.entries(files)) {
    await writeFile(join(dir, name), pair.up);
    await writeFile(join(dir, "down", name.replace(/\.sql$/, ".down.sql")), pair.down);
  }
}

const baseSet = {
  "0001_items.sql": { up: MIGRATION_0001, down: DOWN_0001 },
  "0002_items_name.sql": { up: MIGRATION_0002, down: DOWN_0002 }
} as const;

let cluster: EmbeddedPostgres;
let port = 0;
let workRoot = "";
let connectionString = "";
let clusterReady = false;

const e2eEnabled = process.env.RUN_PG_E2E === "true";

beforeAll(async () => {
  if (!e2eEnabled) return;
  port = await freePort();
  workRoot = await mkdtemp(join(tmpdir(), "pg-e2e-"));
  cluster = new EmbeddedPostgres({
    databaseDir: join(workRoot, "data"),
    user: "map",
    password: "map",
    port,
    persistent: false
  });
  await cluster.initialise();
  await cluster.start();
  await cluster.createDatabase("e2e");
  connectionString = `postgres://map:map@127.0.0.1:${port}/e2e`;
  clusterReady = true;
}, 120_000);

afterAll(async () => {
  if (!clusterReady) return;
  await cluster.stop();
  await rm(workRoot, { recursive: true, force: true });
}, 60_000);

async function freshDatabase(name: string): Promise<void> {
  await cluster.dropDatabase(name).catch(() => undefined);
  await cluster.createDatabase(name);
}

// The whole suite requires a real PostgreSQL. It runs only when RUN_PG_E2E=true
// (the embedded binaries and their native libraries are available); otherwise
// it is skipped so plain `pnpm test` stays hermetic.
const e2e = e2eEnabled ? describe : describe.skip;

e2e("migration delivery chain against a real PostgreSQL", () => {
  it("applies migrations, then reports code and schema as the same version", async () => {
    await freshDatabase("e2e_match");
    const dir = join(workRoot, "match");
    await writeMigrationSet(dir, baseSet);

    const client = new Client({ connectionString: `postgres://map:map@127.0.0.1:${port}/e2e_match` });
    await client.connect();
    try {
      const applied = await migrate(client, { directory: dir });
      expect(applied).toEqual(["0001_items.sql", "0002_items_name.sql"]);

      const verification = await verifyMigrations(client, await loadMigrations(dir));
      expect(verification.upToDate).toBe(true);

      // The startup gate passes: deployed code and DB are the same version.
      const result = await assertDatabaseVersion(client, { migrations: await loadMigrations(dir) });
      expect(result.current).toBe("0002_items_name.sql");
      expect(result.expected).toBe("0002_items_name.sql");

      const table = await client.query("SELECT name FROM items LIMIT 0");
      expect(table.fields.some((f) => f.name === "name")).toBe(true);
    } finally {
      await client.end();
    }
  });

  it("blocks startup when the database is behind the application (pending migration)", async () => {
    await freshDatabase("e2e_behind");
    const dir = join(workRoot, "behind");
    await writeMigrationSet(dir, baseSet);
    const client = new Client({ connectionString: `postgres://map:map@127.0.0.1:${port}/e2e_behind` });
    await client.connect();
    try {
      await migrate(client, { directory: dir });

      // A new release ships 0003 but the database has not run it yet.
      await writeMigrationSet(dir, { "0003_extra.sql": { up: MIGRATION_0003, down: DOWN_0003 } });

      const verification = await verifyMigrations(client, await loadMigrations(dir));
      expect(verification.pending).toContain("0003_extra.sql");
      await expect(assertDatabaseVersion(client, { migrations: await loadMigrations(dir) })).rejects.toThrow(
        /database is behind the application/
      );
    } finally {
      await client.end();
    }
  });

  it("blocks startup when an applied migration file has drifted on disk", async () => {
    await freshDatabase("e2e_drift");
    const dir = join(workRoot, "drift");
    await writeMigrationSet(dir, baseSet);
    const client = new Client({ connectionString: `postgres://map:map@127.0.0.1:${port}/e2e_drift` });
    await client.connect();
    try {
      await migrate(client, { directory: dir });
      // Tamper with the recorded checksum (simulates a hot-edited migration).
      await client.query("UPDATE schema_migrations SET checksum = $1 WHERE filename = $2", [
        "0".repeat(64),
        "0001_items.sql"
      ]);
      const migrations = await loadMigrations(dir);
      await expect(assertDatabaseVersion(client, { migrations })).rejects.toThrow(/changed on disk/);
      await expect(migrate(client, { directory: dir })).rejects.toThrow(/Refusing to migrate/);
    } finally {
      await client.end();
    }
  });

  it("blocks startup when the database contains a migration unknown to the release (rolled-back code)", async () => {
    await freshDatabase("e2e_ahead");
    const dir = join(workRoot, "ahead");
    await writeMigrationSet(dir, {
      ...baseSet,
      "0003_extra.sql": { up: MIGRATION_0003, down: DOWN_0003 }
    });
    const client = new Client({ connectionString: `postgres://map:map@127.0.0.1:${port}/e2e_ahead` });
    await client.connect();
    try {
      await migrate(client, { directory: dir });

      // Old release only knows 0001/0002.
      await expect(
        assertDatabaseVersion(client, { migrations: await loadMigrations(dir) })
      ).resolves.toBeDefined();
      const oldDir = join(workRoot, "ahead-old");
      await writeMigrationSet(oldDir, baseSet);
      await expect(
        assertDatabaseVersion(client, { migrations: await loadMigrations(oldDir) })
      ).rejects.toThrow(/unknown to this release/);
    } finally {
      await client.end();
    }
  });

  it("rolls a failed upgrade back so the database stays at the previous version", async () => {
    await freshDatabase("e2e_fail");
    const dir = join(workRoot, "fail");
    await writeMigrationSet(dir, baseSet);
    const client = new Client({ connectionString: `postgres://map:map@127.0.0.1:${port}/e2e_fail` });
    await client.connect();
    try {
      await migrate(client, { directory: dir });
      await writeMigrationSet(dir, {
        "0003_broken.sql": {
          up: `CREATE TABLE should_not_exist (id integer); SELECT this_function_does_not_exist();`,
          down: `DROP TABLE IF EXISTS should_not_exist`
        }
      });

      await expect(migrate(client, { directory: dir })).rejects.toThrow(/0003_broken\.sql failed and was rolled back/);

      // The DDL inside the failed transaction was rolled back too.
      const leftover = await client.query(
        "SELECT to_regclass('public.should_not_exist') AS present"
      );
      expect(leftover.rows[0]?.present).toBeNull();

      // The database is still exactly at 0002 and the gate passes for that set.
      expect(await currentVersion(client)).toBe("0002_items_name.sql");
      const cleanDir = join(workRoot, "fail-clean");
      await writeMigrationSet(cleanDir, baseSet);
      await expect(
        assertDatabaseVersion(client, { migrations: await loadMigrations(cleanDir) })
      ).resolves.toBeDefined();
    } finally {
      await client.end();
    }
  });

  it("rolls back the newest migration with its paired down file", async () => {
    await freshDatabase("e2e_down");
    const dir = join(workRoot, "down");
    await writeMigrationSet(dir, {
      ...baseSet,
      "0003_extra.sql": { up: MIGRATION_0003, down: DOWN_0003 }
    });
    const client = new Client({ connectionString: `postgres://map:map@127.0.0.1:${port}/e2e_down` });
    await client.connect();
    try {
      await migrate(client, { directory: dir });
      expect(await currentVersion(client)).toBe("0003_extra.sql");

      const reverted = await rollback(client, { directory: dir, steps: 1 });
      expect(reverted).toEqual(["0003_extra.sql"]);

      const table = await client.query("SELECT to_regclass('public.extra') AS present");
      expect(table.rows[0]?.present).toBeNull();
      expect(await currentVersion(client)).toBe("0002_items_name.sql");
    } finally {
      await client.end();
    }
  });
});

e2e("waitForDatabase against a real cluster", () => {
  it("connects as soon as PostgreSQL answers", async () => {
    const { waitForDatabase } = await import("./guard");
    const client = await waitForDatabase(
      async (attemptTimeoutMs) =>
        new Client({ connectionString, connectionTimeoutMillis: attemptTimeoutMs }),
      { connectTimeoutSeconds: 10, retryDelaySeconds: 1 }
    );
    try {
      const reply = await client.query("SELECT 1 AS ok");
      expect(reply.rows[0]?.ok).toBe(1);
    } finally {
      await client.end();
    }
  }, 30_000);
});
