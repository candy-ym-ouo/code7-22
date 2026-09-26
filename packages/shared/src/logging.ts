import { randomUUID } from "node:crypto";
import pino, { type Logger, type LoggerOptions } from "pino";

export type AppName = "api" | "worker" | "db" | "web-build";

export type CreateLoggerOptions = {
  app: AppName;
  /** "silent" keeps tests quiet; otherwise info/debug/trace/error... */
  level?: string;
  /** When true (development), pretty single-line JSON is still emitted so log
   *  shippers always parse structured output. NODE_ENV drives the level only. */
  version?: string;
};

/**
 * Single structured JSON logger for every process. The API passes this same
 * instance to Fastify; the worker and migration CLIs use it directly.
 * Output is always line-delimited JSON (one object per line) so dev, CI and
 * production logs have identical shape.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const level = options.level ?? process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug");
  const loggerOptions: LoggerOptions = {
    name: options.app,
    level,
    base: {
      app: options.app,
      version: options.version ?? process.env.APP_VERSION ?? "0.0.0-dev",
      env: process.env.NODE_ENV ?? "development"
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers.set-cookie",
        "*.password",
        "*.passwordHash",
        "*.secret",
        "*.token",
        "*.accessKey",
        "*.secretKey"
      ],
      censor: "[redacted]"
    }
  };
  return pino(loggerOptions);
}

export type { Logger } from "pino";

/** Deterministic request/span id used across log lines. */
export function newLogId(): string {
  return randomUUID();
}
