import { createServer, type Server } from "node:http";
import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { buildReadinessReport, runProbes } from "@map/shared/health";
import { config } from "./config";
import { getPool } from "./db";
import { getS3 } from "./storage";
import type { Logger } from "@map/shared/logging";

export type WorkerHealthServer = {
  server: Server;
  close: () => Promise<void>;
};

/**
 * Minimal dependency-free HTTP health endpoint for the worker process:
 *   GET /health/live  - process is up (200 always)
 *   GET /health/ready - postgres/redis/S3 probed with bounded timeouts
 *
 * Orchestrators use /health/ready for rollout gating and /health/live for
 * restart decisions, matching the API contract.
 */
export function startWorkerHealthServer(redisPing: () => Promise<string>, logger: Logger): WorkerHealthServer {
  const server = createServer((req, res) => {
    if (req.url === "/health/live") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "worker" }));
      return;
    }
    if (req.url === "/health/ready") {
      void (async () => {
        const checks = await runProbes([
          { name: "postgres", check: async () => void (await getPool().query("SELECT 1")) },
          {
            name: "redis",
            check: async () => {
              const reply = await redisPing();
              if (reply !== "PONG") throw new Error(`unexpected reply: ${String(reply)}`);
            }
          },
          {
            name: `s3:${config.S3_QUARANTINE_BUCKET}`,
            check: async () => void (await getS3().send(new HeadBucketCommand({ Bucket: config.S3_QUARANTINE_BUCKET })))
          },
          {
            name: `s3:${config.S3_PUBLIC_BUCKET}`,
            check: async () => void (await getS3().send(new HeadBucketCommand({ Bucket: config.S3_PUBLIC_BUCKET })))
          }
        ], config.HEALTH_CHECK_TIMEOUT_MS);
        const report = buildReadinessReport("worker", checks);
        res.writeHead(report.status === "ready" ? 200 : 503, { "content-type": "application/json" });
        res.end(JSON.stringify(report));
      })();
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "not_found" }));
  });

  server.on("clientError", (error) => {
    logger.debug({ err: error }, "health server client error");
  });

  server.listen(config.WORKER_PORT, "0.0.0.0", () => {
    logger.info({ port: config.WORKER_PORT }, "worker health server listening");
  });

  return {
    server,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  };
}
