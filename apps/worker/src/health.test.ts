import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import pino from "pino";
import { startHealthServer } from "./health";
import type { HealthChecks } from "./health";

const logger = pino({ level: "silent" });
const servers: Server[] = [];

async function probe(port: number, path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: response.status, body: await response.json() };
}

function withServer(checkReady: () => Promise<HealthChecks>): { port: number } {
  const port = 31_000 + Math.floor(Math.random() * 4000);
  servers.push(startHealthServer({ port, logger, checkReady }));
  return { port };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("worker health server", () => {
  it("answers liveness without touching dependencies", async () => {
    const { port } = withServer(async () => {
      throw new Error("must not be called");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const response = await probe(port, "/health/live");
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
    expect(response.body.service).toBe("worker");
  });

  it("reports ready when all checks pass", async () => {
    const { port } = withServer(async () => ({ database: "ok", migrations: "ok", redis: "ok" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const response = await probe(port, "/health/ready");
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ready");
  });

  it("returns 503 and per-dependency results on failure", async () => {
    const { port } = withServer(async () => ({ database: "ok", migrations: "fail", redis: "ok" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const response = await probe(port, "/health/ready");
    expect(response.status).toBe(503);
    expect(response.body.status).toBe("not_ready");
    expect(response.body.checks.migrations).toBe("fail");
  });

  it("returns 404 on unknown paths", async () => {
    const { port } = withServer(async () => ({ database: "ok", migrations: "ok", redis: "ok" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const response = await probe(port, "/nope");
    expect(response.status).toBe(404);
  });
});
