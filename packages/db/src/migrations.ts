import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 迁移文件约定：
 * - 文件名 `NNNN_description.sql`，按字典序依次执行。
 * - 文件主体为升级（up）SQL。
 * - 可选的 `-- migrate:down` 标记之后为回滚（down）SQL，
 *   用于升级失败时按相反顺序回退。没有 down 段的迁移不可回滚。
 * - 校验和只覆盖 up 段，追加/修正 down 段不会使已应用迁移失效。
 */
export const DOWN_MARKER = "-- migrate:down";

/** 迁移目录：默认 packages/db/migrations，可用 MIGRATIONS_DIR 覆盖（测试与定制部署）。 */
export const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR
  ? process.env.MIGRATIONS_DIR
  : join(dirname(fileURLToPath(import.meta.url)), "../migrations");

export type Migration = {
  filename: string;
  /** 升级 SQL（不含 down 段）。 */
  up: string;
  /** 回滚 SQL；文件没有 down 段时为 null。 */
  down: string | null;
  /** up 段的 sha256，用于漂移检测。 */
  checksum: string;
};

export function splitMigration(sql: string): { up: string; down: string | null } {
  const lines = sql.split("\n");
  const markerIndex = lines.findIndex((line) => line.trim().toLowerCase() === DOWN_MARKER);
  if (markerIndex === -1) return { up: sql, down: null };
  const up = lines.slice(0, markerIndex).join("\n");
  const down = lines.slice(markerIndex + 1).join("\n").trim();
  return { up, down: down.length > 0 ? down : null };
}

export function migrationChecksum(upSql: string): string {
  return createHash("sha256").update(upSql).digest("hex");
}

export async function loadMigrations(directory: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
  const migrations: Migration[] = [];
  for (const filename of files) {
    const sql = await readFile(join(directory, filename), "utf8");
    const { up, down } = splitMigration(sql);
    migrations.push({ filename, up, down, checksum: migrationChecksum(up) });
  }
  return migrations;
}
