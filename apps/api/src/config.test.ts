import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// 环境一致性：.env.example 是唯一的环境变量样例，
// 配置 schema 中的每个键都必须在样例中有记录，否则交付链会漂移。
const examplePath = join(dirname(fileURLToPath(import.meta.url)), "../../../.env.example");

function exampleKeys(): Set<string> {
  const content = readFileSync(examplePath, "utf8");
  const keys = new Set<string>();
  for (const line of content.split("\n")) {
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line.trim());
    if (match) keys.add(match[1]!);
  }
  return keys;
}

beforeAll(() => {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = "postgres://map:map@127.0.0.1:5499/map";
  process.env.S3_ENDPOINT = "http://127.0.0.1:9000";
  process.env.S3_PUBLIC_ENDPOINT = "http://127.0.0.1:9000";
  process.env.S3_ACCESS_KEY = "test";
  process.env.S3_SECRET_KEY = "test";
  process.env.S3_QUARANTINE_BUCKET = "quarantine";
  process.env.S3_PUBLIC_BUCKET = "public";
  process.env.PUBLIC_MEDIA_BASE_URL = "http://127.0.0.1:9000/public";
  process.env.JWT_ACCESS_SECRET = "test-secret-test-secret-test-secret-32+";
});

describe("environment parity", () => {
  it("documents every API config key in .env.example", async () => {
    const { envSchema } = await import("./config");
    const documented = exampleKeys();
    const missing = Object.keys(envSchema.shape).filter((key) => !documented.has(key));
    expect(missing).toEqual([]);
  });
});
