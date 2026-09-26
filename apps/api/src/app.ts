import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import { config } from "./config";
import { fastifyLoggerOptions } from "@map/shared/logger";
import { assertDatabaseVersion } from "@map/db/version";
import { AppError } from "./errors";
import { pool, query } from "./db";
import { pingRedis } from "./queue";
import { authRoutes } from "./routes/auth";
import { featureRoutes } from "./routes/features";
import { mediaRoutes } from "./routes/media";
import { commentRoutes } from "./routes/comments";
import { reportRoutes } from "./routes/reports";
import { moderationRoutes } from "./routes/moderation";

type CheckStatus = "ok" | "fail" | "skipped";

export async function buildApp() {
  const app = Fastify({
    logger: fastifyLoggerOptions("api", { nodeEnv: config.NODE_ENV, level: config.LOG_LEVEL }),
    trustProxy: true,
    bodyLimit: 1024 * 1024
  });

  await app.register(cookie);
  await app.register(cors, {
    origin: config.APP_ORIGIN,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-CSRF-Token", "Idempotency-Key"]
  });
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute"
  });

  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("Permissions-Policy", "geolocation=(self)");
  });

  // 存活探针：进程还在响应即可，不检查依赖（依赖抖动不应触发重启）。
  app.get("/health/live", async () => ({ status: "ok", service: "api" }));

  // 就绪探针：数据库连通性、迁移版本与 Redis 全部通过才接收流量。
  app.get("/health/ready", async (_request, reply) => {
    const checks: Record<string, CheckStatus> = { database: "ok", migrations: "ok", redis: "ok" };
    let failure: unknown;

    try {
      await query("SELECT 1");
    } catch (error) {
      failure = error;
      checks.database = "fail";
      checks.migrations = "skipped";
    }

    if (checks.database === "ok") {
      try {
        await assertDatabaseVersion(pool);
      } catch (error) {
        failure = error;
        checks.migrations = "fail";
      }
    }

    if (!await pingRedis()) checks.redis = "fail";

    const ready = Object.values(checks).every((value) => value === "ok");
    if (!ready) {
      app.log.error({ checks, err: failure }, "readiness check failed");
      return reply.code(503).send({ status: "not_ready", checks });
    }
    return { status: "ready", checks };
  });

  await app.register(async (api) => {
    api.register(authRoutes);
    api.register(featureRoutes);
    api.register(mediaRoutes);
    api.register(commentRoutes);
    api.register(reportRoutes);
    api.register(moderationRoutes);
  }, { prefix: "/api/v1" });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        type: "about:blank",
        title: "Validation failed",
        status: 400,
        code: "VALIDATION_FAILED",
        detail: "Request did not match the required schema",
        issues: error.issues,
        requestId: request.id
      });
    }
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        type: "about:blank",
        title: error.code,
        status: error.statusCode,
        code: error.code,
        detail: error.message,
        details: error.details,
        requestId: request.id
      });
    }
    request.log.error({ err: error }, "unhandled request error");
    return reply.code(500).send({
      type: "about:blank",
      title: "INTERNAL_ERROR",
      status: 500,
      code: "INTERNAL_ERROR",
      detail: "An unexpected error occurred",
      requestId: request.id
    });
  });

  app.setNotFoundHandler((request, reply) => reply.code(404).send({
    type: "about:blank",
    title: "NOT_FOUND",
    status: 404,
    code: "NOT_FOUND",
    detail: "Route not found",
    requestId: request.id
  }));

  return app;
}
