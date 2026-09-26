/**
 * Application identity shared by health probes and startup logs.
 * APP_VERSION is injected at build/deploy time (image tag or release SHA);
 * the default keeps local development and tests working without it.
 */
export const APP_NAME = "public-space-detail-map";

export function appVersion(): string {
  return process.env.APP_VERSION ?? "0.0.0-dev";
}

export function uptimeSeconds(): number {
  return Math.floor(process.uptime());
}

export type ServiceHealth = {
  name: string;
  status: "ok" | "error";
  latencyMs?: number;
  error?: string;
};

export type ReadinessReport = {
  status: "ready" | "not_ready";
  service: string;
  version: string;
  env: string;
  uptimeSeconds: number;
  time: string;
  checks: ServiceHealth[];
};
