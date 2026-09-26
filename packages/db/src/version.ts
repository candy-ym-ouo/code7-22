import { loadMigrations, MIGRATIONS_DIR } from "./migrations";
import type { Migration } from "./migrations";

/** pg Pool / Client / PoolClient 共有的最小查询接口。 */
export interface Queryable {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

export type AppliedMigration = {
  filename: string;
  checksum: string | null;
  applied_at: string;
};

export type SchemaVersionReport = {
  ok: boolean;
  /** 文件存在但数据库未应用 —— 需要先执行迁移。 */
  pending: string[];
  /** 数据库已应用但代码中不存在 —— 数据库比代码新，禁止启动。 */
  unexpected: string[];
  /** 已应用但校验和不一致 —— 迁移文件被修改过。 */
  drifted: string[];
  /** 已应用迁移中缺少校验和的旧记录（升级迁移器前的历史数据）。 */
  unchecksummed: string[];
};

/**
 * 迁移记录表。早期版本只有 filename/applied_at 两列，
 * 这里负责把表结构演进到当前形态（新增 checksum 列）。
 */
export async function ensureMigrationsTable(client: Queryable): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      checksum text,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query(`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text`);
}

export async function getAppliedMigrations(client: Queryable): Promise<AppliedMigration[]> {
  const result = await client.query<AppliedMigration>(
    `SELECT filename, checksum, applied_at::text AS applied_at
     FROM schema_migrations ORDER BY filename`
  );
  return result.rows;
}

/** 启动期数据库版本检查：代码期望的迁移集合必须与数据库完全一致。 */
export async function checkDatabaseVersion(
  client: Queryable,
  migrations?: Migration[]
): Promise<SchemaVersionReport> {
  const expected = migrations ?? (await loadMigrations(MIGRATIONS_DIR));
  let applied: AppliedMigration[];
  try {
    applied = await getAppliedMigrations(client);
  } catch (error) {
    if (isUndefinedTable(error)) {
      // 全新数据库：所有迁移都待执行
      return {
        ok: false,
        pending: expected.map((migration) => migration.filename),
        unexpected: [],
        drifted: [],
        unchecksummed: []
      };
    }
    throw error;
  }

  const appliedByName = new Map(applied.map((row) => [row.filename, row]));
  const expectedNames = new Set(expected.map((migration) => migration.filename));

  const pending = expected.filter((migration) => !appliedByName.has(migration.filename)).map((m) => m.filename);
  const unexpected = applied.filter((row) => !expectedNames.has(row.filename)).map((row) => row.filename);
  const drifted: string[] = [];
  const unchecksummed: string[] = [];
  for (const migration of expected) {
    const row = appliedByName.get(migration.filename);
    if (!row) continue;
    if (!row.checksum) {
      unchecksummed.push(migration.filename);
    } else if (row.checksum !== migration.checksum) {
      drifted.push(migration.filename);
    }
  }

  return {
    ok: pending.length === 0 && unexpected.length === 0 && drifted.length === 0,
    pending,
    unexpected,
    drifted,
    unchecksummed
  };
}

/** 数据库版本与代码不一致时拒绝启动，并给出修复指引。 */
export async function assertDatabaseVersion(client: Queryable, migrations?: Migration[]): Promise<void> {
  const report = await checkDatabaseVersion(client, migrations);
  if (report.ok) return;

  const problems: string[] = [];
  if (report.pending.length > 0) {
    problems.push(`缺少迁移（先执行 pnpm db:migrate）：${report.pending.join(", ")}`);
  }
  if (report.unexpected.length > 0) {
    problems.push(`数据库版本高于代码（部署匹配的版本或回滚数据库）：${report.unexpected.join(", ")}`);
  }
  if (report.drifted.length > 0) {
    problems.push(`迁移文件与已应用记录不一致（禁止修改已发布迁移）：${report.drifted.join(", ")}`);
  }
  throw new Error(`数据库版本校验失败，拒绝启动：\n- ${problems.join("\n- ")}`);
}

function isUndefinedTable(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "42P01";
}
