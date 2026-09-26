import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigValidationError, loadConfig, resolveNodeEnv, secretString } from "./env";

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

describe("resolveNodeEnv", () => {
  it("defaults to development", () => {
    delete process.env.NODE_ENV;
    expect(resolveNodeEnv({} as NodeJS.ProcessEnv)).toBe("development");
  });

  it("rejects unknown environments", () => {
    expect(() => resolveNodeEnv({ NODE_ENV: "staging" } as NodeJS.ProcessEnv)).toThrow();
  });
});

describe("secretString", () => {
  const schema = (env: string) =>
    z.object({
      SECRET: secretString("SECRET", 32, env === "production").default("development-only-secret-value-1234567890")
    });

  it("accepts the development fallback outside production", () => {
    const parsed = loadConfig(schema("development"), {} as NodeJS.ProcessEnv);
    expect(parsed.SECRET).toContain("development-only");
  });

  it("rejects weak secrets in production", () => {
    expect(() => loadConfig(schema("production"), { SECRET: "short" } as NodeJS.ProcessEnv)).toThrow(
      ConfigValidationError
    );
  });

  it("rejects placeholder/development values in production", () => {
    const value = "development-only-secret-value-1234567890-extra-long";
    expect(() => loadConfig(schema("production"), { SECRET: value } as NodeJS.ProcessEnv)).toThrow(/placeholder/);
  });

  it("accepts a strong non-placeholder secret in production", () => {
    const value = "8f3c1a9e7b6d4f2018ae5c93d7b6f042c8e1a5f9d2b7e4068c3f1a9e7b6d4f20";
    const parsed = loadConfig(schema("production"), { SECRET: value } as NodeJS.ProcessEnv);
    expect(parsed.SECRET).toBe(value);
  });
});

describe("loadConfig", () => {
  it("reports every missing variable with a readable message", () => {
    const schema = z.object({
      REQUIRED_A: z.string().min(1),
      REQUIRED_B: z.string().min(1)
    });
    try {
      loadConfig(schema, {} as NodeJS.ProcessEnv);
      throw new Error("expected ConfigValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const issues = (error as ConfigValidationError).issues.map((issue) => issue.path);
      expect(issues).toContain("REQUIRED_A");
      expect(issues).toContain("REQUIRED_B");
    }
  });

  it("coerces numeric values", () => {
    const schema = z.object({ PORT: z.coerce.number().int() });
    const parsed = loadConfig(schema, { PORT: "3000" } as unknown as NodeJS.ProcessEnv);
    expect(parsed.PORT).toBe(3000);
  });
});
