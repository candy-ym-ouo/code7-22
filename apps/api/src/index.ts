import { createLogger, logLevel } from "@map/shared/logger";

// 入口只静态引入 logger：配置校验失败时也能输出结构化 JSON 日志而不是裸堆栈。
const bootLogger = createLogger("api");

async function main() {
  const { config } = await import("./config");
  const logger = createLogger("api", { level: logLevel(config.NODE_ENV, config.LOG_LEVEL) });

  // 启动校验：配置和密钥已在 config.ts 校验；这里确认数据库迁移版本与代码一致，
  // 版本不匹配（少迁移、数据库更新、文件被改动）时拒绝启动。
  const { pool } = await import("./db");
  const { assertDatabaseVersion } = await import("@map/db/version");
  logger.info("checking database schema version before startup");
  await assertDatabaseVersion(pool);
  logger.info("database schema version matches code");

  const { buildApp } = await import("./app");
  const { closeQueues } = await import("./queue");
  const app = await buildApp();

  try {
    await app.listen({ host: "0.0.0.0", port: config.PORT });
  } catch (error) {
    logger.error({ err: error }, "failed to start API");
    process.exit(1);
  }

  async function shutdown(signal: string) {
    logger.info({ signal }, "shutting down");
    await app.close();
    await closeQueues();
    await pool.end();
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  bootLogger.error({ err: error }, "API startup aborted");
  process.exit(1);
});
