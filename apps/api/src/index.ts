import "@map/shared/bootstrap";
import { buildApp, logger } from "./app";
import { runStartupChecks } from "./startup";
import { connectQueues, closeQueues } from "./queue";
import { getPool } from "./db";
import { config } from "./config";

async function main() {
  // Gate database version, signing key, Redis and S3 before opening any
  // long-lived connection or accepting traffic.
  await runStartupChecks(logger);

  // Only now create the persistent pool and BullMQ connections.
  connectQueues();
  getPool();

  const app = await buildApp();
  try {
    await app.listen({ host: "0.0.0.0", port: config.PORT });
    logger.info({ port: config.PORT }, "api listening");
  } catch (error) {
    logger.error({ err: error }, "failed to start HTTP server");
    process.exit(1);
  }

  async function shutdown(signal: string) {
    logger.info({ signal }, "shutting down");
    await app.close();
    await closeQueues();
    await getPool().end();
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  logger.error({ err: error }, "startup failed");
  process.exit(1);
});
