import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * Load .env once from the repository root (or ENV_FILE override).
 * Every Node entry point (API, worker, migration/seed/admin CLIs) uses this so
 * development, test and production resolve environment the same way.
 */
export function loadEnvFile(env: NodeJS.ProcessEnv = process.env): void {
  const dotenvOptions = { quiet: true } as const;
  if (env.ENV_FILE) {
    dotenv.config({ ...dotenvOptions, path: env.ENV_FILE });
    return;
  }
  const sharedSrcDir = dirname(fileURLToPath(import.meta.url));
  const candidateDirs = [
    process.cwd(),
    join(sharedSrcDir, "../../../../.."),
    join(sharedSrcDir, "../../../")
  ];
  for (const directory of candidateDirs) {
    const result = dotenv.config({ ...dotenvOptions, path: join(directory, ".env") });
    if (!result.error) return;
  }
}

export type ConfigIssue = { path: string; message: string };

export class ConfigValidationError extends Error {
  readonly issues: ConfigIssue[];

  constructor(issues: ConfigIssue[]) {
    super(
      [
        "Environment configuration is invalid:",
        ...issues.map((issue) => `  - ${issue.path}: ${issue.message}`)
      ].join("\n")
    );
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

/**
 * Parse and validate a configuration object. Fail fast with a clear, numbered
 * list of every missing or malformed variable instead of Zod's default error
 * dump, and never print secret values.
 */
export function loadConfig<S extends z.ZodTypeAny>(schema: S, source: NodeJS.ProcessEnv = process.env): z.output<S> {
  const result = schema.safeParse(source);
  if (result.success) return result.data;
  const issues: ConfigIssue[] = result.error.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    message: issue.message
  }));
  throw new ConfigValidationError(issues);
}

const PLACEHOLDER_PATTERN = /(change-?me|example|placeholder|dev(?:elopment)?(?:-|_)?(?:only|secret|key|fallback))/i;

/**
 * Secret policy shared by API and worker:
 * - production requires strong, explicitly provided secrets (minimum length,
 *   rejects obvious placeholders and development fallbacks);
 * - development/test accept any value so local and CI environments behave
 *   identically without extra setup.
 *
 * Pair with `.default(...)` (the development fallback) at the call site.
 */
export function secretString(envVar: string, minLength: number, isProduction: boolean) {
  return z.string().superRefine((value, ctx) => {
    if (!isProduction) return;
    if (value.length < minLength) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${envVar} must be at least ${minLength} characters in production`
      });
    }
    if (PLACEHOLDER_PATTERN.test(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${envVar} must not use a placeholder or development value in production`
      });
    }
  });
}

/** Resolve NODE_ENV before building the rest of the schema (drives secret policy). */
export function resolveNodeEnv(source: NodeJS.ProcessEnv = process.env) {
  return z.enum(["development", "test", "production"]).default("development").parse(source.NODE_ENV);
}
