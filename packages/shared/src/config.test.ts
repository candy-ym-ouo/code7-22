import { describe, expect, it } from "vitest";
import { z } from "zod";
import { assertSecrets, booleanFromEnv, isWeakSecret, parseEnv } from "./config";

describe("booleanFromEnv", () => {
  it("parses common boolean spellings and falls back otherwise", () => {
    const schema = z.object({ FLAG: booleanFromEnv("true") });
    expect(parseEnv(schema, { FLAG: "false" }).FLAG).toBe(false);
    expect(parseEnv(schema, { FLAG: "TRUE" }).FLAG).toBe(true);
    expect(parseEnv(schema, { FLAG: " true " }).FLAG).toBe(true);
    expect(parseEnv(schema, {}).FLAG).toBe(true);
  });
});

describe("isWeakSecret", () => {
  it("rejects known placeholder values", () => {
    expect(isWeakSecret("change-me")).toBe(true);
    expect(isWeakSecret("REPLACE-WITH-A-LONG-RANDOM-SECRET")).toBe(true);
  });

  it("rejects repetitive filler", () => {
    expect(isWeakSecret("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(true);
  });

  it("accepts high-entropy values", () => {
    expect(isWeakSecret("x9Qm2!vT7@kP4#zW8sLd6Rb0YhFn3UcA1")).toBe(false);
  });
});

describe("assertSecrets", () => {
  const rules = [{ key: "JWT_ACCESS_SECRET", minLength: 32 }];

  it("accepts a strong secret in every environment", () => {
    expect(() =>
      assertSecrets({ JWT_ACCESS_SECRET: "x9Qm2!vT7@kP4#zW8sLd6Rb0YhFn3UcA1" }, rules, "development")
    ).not.toThrow();
  });

  it("rejects short secrets in every environment", () => {
    expect(() => assertSecrets({ JWT_ACCESS_SECRET: "short" }, rules, "development")).toThrow(/长度不足/);
  });

  it("allows the documented placeholder outside production", () => {
    expect(() =>
      assertSecrets({ JWT_ACCESS_SECRET: "replace-with-a-long-random-secret" }, rules, "development")
    ).not.toThrow();
  });

  it("rejects the placeholder in production", () => {
    expect(() =>
      assertSecrets({ JWT_ACCESS_SECRET: "replace-with-a-long-random-secret" }, rules, "production")
    ).toThrow(/弱密钥/);
  });

  it("reports missing keys", () => {
    expect(() => assertSecrets({}, rules, "development")).toThrow(/未配置/);
  });
});

describe("parseEnv", () => {
  it("lists every validation failure with its variable name", () => {
    const schema = z.object({
      DATABASE_URL: z.string().min(1),
      PORT: z.coerce.number().int().positive()
    });
    expect(() => parseEnv(schema, { PORT: "-1" })).toThrow(/DATABASE_URL/);
    expect(() => parseEnv(schema, { PORT: "-1" })).toThrow(/环境变量校验失败/);
  });

  it("returns typed values on success", () => {
    const schema = z.object({ PORT: z.coerce.number().int().positive().default(3000) });
    expect(parseEnv(schema, {}).PORT).toBe(3000);
    expect(parseEnv(schema, { PORT: "8080" }).PORT).toBe(8080);
  });
});
