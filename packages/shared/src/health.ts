import { performance } from "node:perf_hooks";
import { appVersion, uptimeSeconds, type ReadinessReport, type ServiceHealth } from "./app-meta";

/** Minimal structural types so this module needs no pg/ioredis/aws-sdk deps. */
export interface HealthProbe {
  name: string;
  check: () => Promise<void>;
}

async function timedCheck(name: string, run: () => Promise<void>, timeoutMs: number): Promise<ServiceHealth> {
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} check timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
    return { name, status: "ok", latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    return {
      name,
      status: "error",
      latencyMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Probe every runtime dependency with a bounded per-check timeout. */
export async function runProbes(probes: HealthProbe[], timeoutMs = 2_000): Promise<ServiceHealth[]> {
  return Promise.all(probes.map((probe) => timedCheck(probe.name, probe.check, timeoutMs)));
}

export function buildReadinessReport(service: string, checks: ServiceHealth[]): ReadinessReport {
  return {
    status: checks.every((check) => check.status === "ok") ? "ready" : "not_ready",
    service,
    version: appVersion(),
    env: process.env.NODE_ENV ?? "development",
    uptimeSeconds: uptimeSeconds(),
    time: new Date().toISOString(),
    checks
  };
}
