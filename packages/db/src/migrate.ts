import { loadEnvFile } from "@map/shared/config";

loadEnvFile();

import pg from "pg";
import { loadMigrations } from "./migrations";
import type { Migration } from "./migrations";
import { ensureMigrationsTable, getAppliedMigrations, checkDatabaseVersion } from "./version";
import type { Queryable } from "./version";

const { Client } = pg;

/** 同一时刻只允许一个迁移进程，避免多副本部署时并发执行迁移。 */
const MIGRATION_LOCK_KEY = 728_410_001;

async function acquireLock(client: Queryable): Promise<void> {
  await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
}

async function releaseLock(client: Queryable): Promise<void> {
  await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
}

/** 旧版本迁移器没有记录校验和，这里为历史记录补登，使漂移检测生效。 */
async function backfillChecksums(client: Queryable, migrations: Migration[]): Promise<void> {
  for (const migration of migrations) {
    await client.query(
      "UPDATE schema_migrations SET checksum = $2 WHERE filename = $1 AND checksum IS NULL",
      [migration.filename, migration.checksum]
    );
  }
}

async function applyUp(client: Queryable): Promise<void> {
  const migrations = await loadMigrations();
  await ensureMigrationsTable(client);
  await backfillChecksums(client, migrations);

  const report = await checkDatabaseVersion(client, migrations);
  if (report.unexpected.length > 0) {
    throw new Error(`数据库包含代码中不存在的迁移记录：${report.unexpected.join(", ")}，请部署匹配的代码版本`);
  }
  if (report.drifted.length > 0) {
    throw new Error(`迁移文件与已应用记录不一致：${report.drifted.join(", ")}，禁止修改已发布迁移`);
  }
  if (report.pending.length === 0) {
    console.log("database is up to date");
    return;
  }

  const byName = new Map(migrations.map((migration) => [migration.filename, migration]));
  for (const filename of report.pending) {
    const migration = byName.get(filename);
    if (!migration) continue;
    await client.query("BEGIN");
    try {
      await client.query(migration.up);
      await client.query("INSERT INTO schema_migrations(filename, checksum) VALUES ($1, $2)", [
        migration.filename,
        migration.checksum
      ]);
      await client.query("COMMIT");
      console.log(`applied ${filename}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
}

async function applyDown(client: Queryable, steps: number): Promise<void> {
  const migrations = await loadMigrations();
  await ensureMigrationsTable(client);
  const byName = new Map(migrations.map((migration) => [migration.filename, migration]));
  const applied = await getAppliedMigrations(client);

  // 按应用顺序的逆序回滚
  const targets = applied.slice(-steps).reverse();
  if (targets.length === 0) {
    console.log("nothing to roll back");
    return;
  }

  for (const row of targets) {
    const migration = byName.get(row.filename);
    if (!migration) {
      throw new Error(`无法回滚 ${row.filename}：代码中不存在该迁移文件，请先部署包含它的版本`);
    }
    if (!migration.down) {
      throw new Error(`无法回滚 ${row.filename}：迁移没有 down 段，请手工处理或补充 -- migrate:down`);
    }
    await client.query("BEGIN");
    try {
      await client.query(migration.down);
      await client.query("DELETE FROM schema_migrations WHERE filename = $1", [row.filename]);
      await client.query("COMMIT");
      console.log(`rolled back ${row.filename}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
}

async function printStatus(client: Queryable): Promise<void> {
  const migrations = await loadMigrations();
  let report;
  try {
    await ensureMigrationsTable(client);
    report = await checkDatabaseVersion(client, migrations);
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "42P01") {
      report = null;
    } else {
      throw error;
    }
  }
  const applied = new Set(
    report ? migrations.filter((m) => !report.pending.includes(m.filename)).map((m) => m.filename) : []
  );
  for (const migration of migrations) {
    const state = applied.has(migration.filename) ? "applied" : "pending";
    const reversible = migration.down ? "reversible" : "no-down";
    console.log(`${state}\t${reversible}\t${migration.filename}`);
  }
  if (report && report.unexpected.length > 0) {
    for (const filename of report.unexpected) console.log(`unexpected\t-\t${filename}`);
  }
  if (report && report.drifted.length > 0) {
    for (const filename of report.drifted) console.log(`drifted\t-\t${filename}`);
  }
}

async function main() {
  const command = process.argv[2] ?? "up";
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await acquireLock(client);
    try {
      if (command === "up") {
        await applyUp(client);
      } else if (command === "down" || command === "rollback") {
        const stepsArg = process.argv[3];
        const steps = stepsArg ? Number.parseInt(stepsArg, 10) : 1;
        if (!Number.isInteger(steps) || steps < 1) throw new Error("回滚步数必须是正整数");
        await applyDown(client, steps);
      } else if (command === "status") {
        await printStatus(client);
      } else if (command === "verify") {
        const migrations = await loadMigrations();
        await ensureMigrationsTable(client);
        const report = await checkDatabaseVersion(client, migrations);
        if (!report.ok) {
          console.error(JSON.stringify(report, null, 2));
          process.exitCode = 1;
          return;
        }
        console.log("schema version matches code");
      } else {
        throw new Error(`未知命令：${command}（可用：up | down [步数] | status | verify）`);
      }
    } finally {
      await releaseLock(client);
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
