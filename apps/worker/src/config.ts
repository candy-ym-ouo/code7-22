import { z } from "zod";
import { booleanFromEnv, loadEnvFile, parseEnv } from "@map/shared/config";

loadEnvFile();

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z
    .union([z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]), z.literal("")])
    .optional()
    .transform((value) => (value ? value : undefined)),
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(3100),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379/0"),
  S3_ENDPOINT: z.string().url(),
  S3_PUBLIC_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_QUARANTINE_BUCKET: z.string().min(1),
  S3_PUBLIC_BUCKET: z.string().min(1),
  MEDIA_MAX_PIXELS: z.coerce.number().int().positive().default(20_000_000),
  PRIVACY_DETECTOR_URL: z.string().url().optional().or(z.literal("")),
  PRIVACY_BLUR_SIGMA: z.coerce.number().positive().default(32),
  PRIVACY_BLUR_PADDING: z.coerce.number().min(0).max(0.5).default(0.08),
  ORIGINAL_RETENTION_HOURS: z.coerce.number().positive().default(24),
  CLAMAV_ENABLED: booleanFromEnv("true"),
  CLAMAV_HOST: z.string().default("localhost"),
  CLAMAV_PORT: z.coerce.number().int().positive().default(3310),
  SMTP_HOST: z.string().default("localhost"),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_SECURE: booleanFromEnv("false"),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().default("公共空间细节地图 <noreply@example.test>")
});

export const config = parseEnv(envSchema);

if (config.NODE_ENV === "production" && !config.CLAMAV_ENABLED) {
  throw new Error("配置校验失败：生产环境禁止 CLAMAV_ENABLED=false，媒体必须执行病毒扫描");
}
