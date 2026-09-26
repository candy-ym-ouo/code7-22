import { z } from "zod";
import { loadConfig, loadEnvFile } from "@map/shared/env";

loadEnvFile();

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  DB_CONNECT_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(30),
  MIGRATE_ALLOW_DRIFT: z.string().default("false").transform((value) => value === "true")
});

export const dbConfig = loadConfig(schema, process.env);
