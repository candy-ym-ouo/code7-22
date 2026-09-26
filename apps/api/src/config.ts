import { z } from "zod";
import { assertSecrets, booleanFromEnv, loadEnvFile, parseEnv } from "@map/shared/config";

loadEnvFile();

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .union([z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]), z.literal("")])
    .optional()
    .transform((value) => (value ? value : undefined)),
  APP_ORIGIN: z.string().url().default("http://localhost:5173"),
  PUBLIC_API_URL: z.string().url().default("http://localhost:3000/api/v1"),
  COOKIE_SECURE: booleanFromEnv("false"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379/0"),
  S3_ENDPOINT: z.string().url(),
  S3_PUBLIC_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_QUARANTINE_BUCKET: z.string().min(1),
  S3_PUBLIC_BUCKET: z.string().min(1),
  PUBLIC_MEDIA_BASE_URL: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL: z.string().default("10m"),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  MEDIA_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  MEDIA_MAX_PER_FEATURE: z.coerce.number().int().positive().default(6)
});

export const config = parseEnv(envSchema);

assertSecrets(
  config as unknown as Record<string, unknown>,
  [{ key: "JWT_ACCESS_SECRET", minLength: 32 }],
  config.NODE_ENV
);

if (config.NODE_ENV === "production") {
  if (!config.COOKIE_SECURE) {
    throw new Error("配置校验失败：生产环境必须设置 COOKIE_SECURE=true");
  }
  if (config.APP_ORIGIN.startsWith("http://") || config.PUBLIC_API_URL.startsWith("http://")) {
    throw new Error("配置校验失败：生产环境 APP_ORIGIN 与 PUBLIC_API_URL 必须使用 https");
  }
}

export type AppConfig = typeof config;
