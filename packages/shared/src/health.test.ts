import { describe, expect, it } from "vitest";
import { buildReadinessReport, runProbes } from "./health";

describe("runProbes", () => {
  it("reports ok probes with latency", async () => {
    const checks = await runProbes([
      { name: "a", check: async () => undefined },
      { name: "b", check: async () => undefined }
    ]);
    expect(checks.map((c) => c.name)).toEqual(["a", "b"]);
    expect(checks.every((c) => c.status === "ok")).toBe(true);
    expect(checks.every((c) => typeof c.latencyMs === "number")).toBe(true);
  });

  it("captures failing probes without throwing and bounds slow probes by timeout", async () => {
    const checks = await runProbes([
      { name: "boom", check: async () => {
        throw new Error("connection refused");
      } },
      {
        name: "slow",
        check: () => new Promise<void>((resolve) => setTimeout(resolve, 5_000))
      }
    ], 50);
    const byName = new Map(checks.map((check) => [check.name, check]));
    expect(byName.get("boom")?.status).toBe("error");
    expect(byName.get("boom")?.error).toContain("connection refused");
    expect(byName.get("slow")?.status).toBe("error");
    expect(byName.get("slow")?.error).toContain("timed out");
  });
});

describe("buildReadinessReport", () => {
  it("is ready only when every check is ok", () => {
    const ready = buildReadinessReport("api", [{ name: "db", status: "ok" }]);
    expect(ready.status).toBe("ready");
    expect(ready.service).toBe("api");
    expect(ready.version).toBeTruthy();
    expect(Number.isFinite(ready.uptimeSeconds)).toBe(true);

    const notReady = buildReadinessReport("api", [
      { name: "db", status: "ok" },
      { name: "redis", status: "error", error: "down" }
    ]);
    expect(notReady.status).toBe("not_ready");
  });
});
