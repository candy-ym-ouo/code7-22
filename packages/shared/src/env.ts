import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import dotenv from "dotenv";

/**
 * 统一的环境变量加载：所有服务（api、worker、db CLI）从同一份 .env 读取，
 * 保证本地开发、测试和容器内看到一致的环境结果。
 *
 * 优先级：
 * 1. `ENV_FILE` 显式指定的文件。
 * 2. 从 cwd 向上找到的 workspace 根（含 pnpm-workspace.yaml）下的 `.env`。
 * 3. cwd 下的 `.env`。
 *
 * 已存在的 process.env 永远优先于文件内容（dotenv 默认行为）。
 */
export function loadEnvFile(startDir: string = process.cwd()): void {
  const explicit = process.env.ENV_FILE;
  if (explicit) {
    dotenv.config({ path: explicit, quiet: true });
    return;
  }
  dotenv.config({ path: join(findWorkspaceRoot(startDir), ".env"), quiet: true });
}

export function findWorkspaceRoot(startDir: string = process.cwd()): string {
  let current = startDir;
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return startDir;
}
