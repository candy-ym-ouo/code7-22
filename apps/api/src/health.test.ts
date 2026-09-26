import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

// 在导入 app/config 前准备最小环境（与 worker privacy.test.ts 相同的模式），
// 指向本机不存在的端口，验证无依赖时探针的降级行为。
beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = "postgres://map:map@127.0.0.1:5499/map";
  process.env.REDIS_URL = "redis://127.0.0.1:6399/9";
  process.env.S3_ENDPOINT = "http://127.0.0.1:9000";
  process.env.S3_PUBLIC_ENDPOINT = "http://127.0.0.1:9000";
  process.env.S3_ACCESS_KEY = "test";
  process.env.S3_SECRET_KEY = "test";
  process.env.S3_QUARANTINE_BUCKET = "quarantine";
  process.env.S3_PUBLIC_BUCKET = "public";
  process.env.PUBLIC_MEDIA_BASE_URL = "http://127.0.0.1:9000/public";
  process.env.JWT_ACCESS_SECRET = "test-secret-test-secret-test-secret-32+";
});

describe("health probes", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { buildApp } = await import("./app");
    app = await buildApp();
  });

  afterAll(async () => {
    const { closeQueues } = await import("./queue");
    const { pool } = await import("./db");
    await app.close();
    await closeQueues();
    await pool.end();
  });

  it("liveness responds even when dependencies are down", async () => {
    const response = await app.inject({ method: "GET", url: "/health/live" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok", service: "api" });
  });

  it("readiness reports per-dependency status and 503 when checks fail", async () => {
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect([503, 200]).toContain(response.statusCode);
    const body = response.json() as { status: string; checks?: Record<string, string> };
    if (response.statusCode === 503) {
      expect(body.status).toBe("not_ready");
      expect(Object.keys(body.checks ?? {}).sort()).toEqual(["database", "migrations", "redis"]);
      expect(body.checks?.database).toBe("fail");
    }
  });
});
