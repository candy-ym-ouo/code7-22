import pino from "pino";
import type { LoggerOptions } from "pino";

export type ServiceName = "api" | "worker" | "migrate" | string;

/** 所有服务共享的日志脱敏路径（Header、令牌、密码、密钥）。 */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers.set-cookie",
  "*.password",
  "*.passwordHash",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.secret",
  "*.jwtAccessSecret"
] as const;

export function logLevel(nodeEnv: string | undefined, configured?: string): string {
  return configured?.trim().toLowerCase() || (nodeEnv === "production" ? "info" : "debug");
}

/** 所有服务统一的日志格式：JSON、UTC 时间、服务名、requestId 关联。 */
export function createLogger(service: ServiceName, options: { level?: string | undefined } = {}): pino.Logger {
  return pino({
    name: service,
    level: options.level ?? "info",
    timestamp: pino.stdTimeFunctions.isoTime,
    base: null,
    redact: { paths: [...REDACT_PATHS], censor: "[redacted]" },
    formatters: {
      level(label) {
        return { level: label };
      }
    }
  });
}

/** 传给 Fastify 的 logger 选项，保证 API 请求日志与 Worker 日志格式一致。 */
export function fastifyLoggerOptions(
  service: ServiceName,
  options: { nodeEnv?: string | undefined; level?: string | undefined } = {}
): LoggerOptions {
  return {
    name: service,
    level: logLevel(options.nodeEnv, options.level),
    timestamp: pino.stdTimeFunctions.isoTime,
    base: null,
    redact: { paths: [...REDACT_PATHS], censor: "[redacted]" },
    serializers: {
      req: (req: { method?: string; url?: string }) => ({
        method: req.method,
        url: req.url
      }),
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode })
    },
    formatters: {
      level(label) {
        return { level: label };
      }
    }
  };
}
