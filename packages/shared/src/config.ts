import { z, ZodError } from "zod";

export { loadEnvFile, findWorkspaceRoot } from "./env";

/** `"true"` / `"false"` 字符串到布尔值的统一转换。 */
export const booleanFromEnv = (fallback: string) =>
  z.string().default(fallback).transform((value) => value.trim().toLowerCase() === "true");

/** 已知弱密钥/占位值。生产环境命中任一值时拒绝启动。 */
export const WEAK_SECRET_VALUES = new Set([
  "change-me",
  "changeme",
  "change-me-in-production",
  "secret",
  "password",
  "development-secret",
  "dev-secret",
  "test-secret",
  "replace-with-a-long-random-secret",
  "replace-with-a-long-random-secret-in-production"
]);

export function isWeakSecret(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (WEAK_SECRET_VALUES.has(normalized)) return true;
  // 全是同一字符或纯顺序字符的密钥等同于没有密钥
  if (/^(.)\1+$/.test(normalized)) return true;
  return false;
}

export type SecretRule = {
  /** 配置对象上的键名，用于错误信息。 */
  key: string;
  /** 最小长度，默认 32。 */
  minLength?: number;
};

/**
 * 启动期密钥校验：任何环境下密钥都必须达到最小长度；
 * 生产环境额外拒绝已知弱密钥/占位值。
 */
export function assertSecrets(
  config: Record<string, unknown>,
  rules: SecretRule[],
  nodeEnv: string
): void {
  const problems: string[] = [];
  for (const rule of rules) {
    const raw = config[rule.key];
    if (typeof raw !== "string") {
      problems.push(`${rule.key} 未配置`);
      continue;
    }
    const minLength = rule.minLength ?? 32;
    if (raw.length < minLength) {
      problems.push(`${rule.key} 长度不足（需要至少 ${minLength} 个字符）`);
    }
    if (nodeEnv === "production" && isWeakSecret(raw)) {
      problems.push(`${rule.key} 使用了已知弱密钥或占位值，生产环境必须更换`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`密钥校验失败，拒绝启动：\n- ${problems.join("\n- ")}`);
  }
}

/** 解析并校验环境变量；失败时抛出可读的错误列表而不是原始 ZodError。 */
export function parseEnv<T>(schema: z.ZodType<T>, env: NodeJS.ProcessEnv = process.env): T {
  try {
    return schema.parse(env);
  } catch (error) {
    if (error instanceof ZodError) {
      const lines = error.issues.map((issue) => {
        const path = issue.path.join(".") || "(root)";
        return `- ${path}: ${issue.message}`;
      });
      throw new Error(`环境变量校验失败：\n${lines.join("\n")}`);
    }
    throw error;
  }
}
