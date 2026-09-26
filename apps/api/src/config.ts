import { z } from "zod";
import { loadConfig, loadEnvFile, resolveNodeEnv, secretString } from "@map/shared/env";

loadEnvFile();

const nodeEnv = resolveNodeEnv();

const baseSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default(nodeEnv),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_ORIGIN: z.string().url().default("http://localhost:5173"),
  PUBLIC_API_URL: z.string().url().default("http://localhost:3000/api/v1"),
  COOKIE_SECURE: z.string().default("false").transform((value) => value === "true"),
  DATABASE_URL: z.string().min(1),
  DB_CONNECT_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(30),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379/0"),
  S3_ENDPOINT: z.string().url(),
  S3_PUBLIC_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_QUARANTINE_BUCKET: z.string().min(1),
  S3_PUBLIC_BUCKET: z.string().min(1),
  PUBLIC_MEDIA_BASE_URL: z.string().url(),
  JWT_ACCESS_SECRET: secretString("JWT_ACCESS_SECRET", 32, nodeEnv === "production")
    .default("development-only-access-secret-do-not-use-in-production-0001"),
  ACCESS_TOKEN_TTL: z.string().default("10m"),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  MEDIA_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  MEDIA_MAX_PER_FEATURE: z.coerce.number().int().positive().default(6),
  HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000)
});

const schema = nodeEnv === "production"
  ? baseSchema.superRefine((value, ctx) => {
      if (value.NODE_ENV !== "production") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["NODE_ENV"],
          message: `NODE_ENV resolved to ${nodeEnv} but the object parsed to ${value.NODE_ENV}`
        });
      }
      if (!value.COOKIE_SECURE) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["COOKIE_SECURE"],
          message: "COOKIE_SECURE must be true in production when serving over HTTPS"
        });
      }
      if (!value.APP_ORIGIN.startsWith("https://")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["APP_ORIGIN"],
          message: "APP_ORIGIN must be an https:// URL in production"
        });
      }
      if (!value.PUBLIC_MEDIA_BASE_URL.startsWith("https://")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["PUBLIC_MEDIA_BASE_URL"],
          message: "PUBLIC_MEDIA_BASE_URL must be an https:// URL in production"
        });
      }
    })
  : baseSchema;

export const config = loadConfig(schema, process.env);
export type AppConfig = typeof config;
