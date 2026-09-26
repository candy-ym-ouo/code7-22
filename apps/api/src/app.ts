import Fastify, { type FastifyBaseLogger } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { ZodError } from "zod";
import { createLogger } from "@map/shared/logging";
import { buildReadinessReport, runProbes } from "@map/shared/health";
import { config } from "./config";
import { AppError } from "./errors";
import { query } from "./db";
import { getMediaRedis } from "./queue";
import { getInternalS3 } from "./storage";
import { authRoutes } from "./routes/auth";
import { featureRoutes } from "./routes/features";
import { mediaRoutes } from "./routes/media";
import { commentRoutes } from "./routes/comments";
import { reportRoutes } from "./routes/reports";
import { moderationRoutes } from "./routes/moderation";

export const logger = createLogger({ app: "api" });

export async function buildApp() {
  const app = Fastify({
    logger: logger as unknown as FastifyBaseLogger,
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

  // Liveness: the process event loop is up. Never touches dependencies so a
  // database outage never forces an orchestrator restart loop.
  app.get("/health/live", async () => ({ status: "ok" }));

  // Readiness: every runtime dependency must answer within the configured
  // timeout. Returns 503 with the failing check until the service recovers.
  app.get("/health/ready", { logLevel: "debug" }, async (_request, reply) => {
    const checks = await runProbes([
      { name: "postgres", check: async () => void (await query("SELECT 1")) },
      {
        name: "redis",
        check: async () => {
          const redisReply = await getMediaRedis().ping();
          if (redisReply !== "PONG") throw new Error(`unexpected reply: ${String(redisReply)}`);
        }
      },
      {
        name: `s3:${config.S3_QUARANTINE_BUCKET}`,
        check: async () => void (await getInternalS3().send(new HeadBucketCommand({ Bucket: config.S3_QUARANTINE_BUCKET })))
      },
      {
        name: `s3:${config.S3_PUBLIC_BUCKET}`,
        check: async () => void (await getInternalS3().send(new HeadBucketCommand({ Bucket: config.S3_PUBLIC_BUCKET })))
      }
    ], config.HEALTH_CHECK_TIMEOUT_MS);
    const report = buildReadinessReport("api", checks);
    return reply.code(report.status === "ready" ? 200 : 503).send(report);
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
