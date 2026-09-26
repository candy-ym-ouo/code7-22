import { createServer } from "node:http";
import type { Server } from "node:http";
import type { Logger } from "pino";

export type HealthChecks = Record<string, "ok" | "fail" | "skipped">;

/**
 * Worker 不暴露业务端口，但编排系统（compose/k8s）仍需要探针。
 * 与 API 相同的约定：
 * - /health/live  进程存活，不检查依赖；
 * - /health/ready 依赖（数据库、迁移版本、Redis）全部通过才返回 200。
 */
export function startHealthServer(options: {
  port: number;
  logger: Logger;
  checkReady: () => Promise<HealthChecks>;
}): Server {
  const server = createServer((request, response) => {
    const send = (statusCode: number, body: unknown) => {
      response.writeHead(statusCode, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };

    if (request.url === "/health/live") {
      send(200, { status: "ok", service: "worker" });
      return;
    }
    if (request.url === "/health/ready") {
      options
        .checkReady()
        .then((checks) => {
          const ready = Object.values(checks).every((value) => value === "ok");
          send(ready ? 200 : 503, { status: ready ? "ready" : "not_ready", checks });
        })
        .catch((error) => {
          options.logger.error({ err: error }, "readiness check failed");
          send(503, { status: "not_ready", checks: { internal: "fail" } });
        });
      return;
    }
    send(404, { status: "not_found" });
  });

  server.listen(options.port, "0.0.0.0", () => {
    options.logger.info({ port: options.port }, "worker health probe listening");
  });
  return server;
}
