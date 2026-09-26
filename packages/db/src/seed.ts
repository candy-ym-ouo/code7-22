import "@map/shared/bootstrap";
import { Client } from "pg";
import { createLogger } from "@map/shared";
import { categoryDefinitions } from "@map/shared/contracts";
import { dbConfig } from "./config";

const logger = createLogger({ app: "db" });

async function main() {
  const client = new Client({ connectionString: dbConfig.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    for (const category of categoryDefinitions) {
      await client.query(
        `INSERT INTO categories(key, name, icon, detail_schema, sort_order, is_active)
         VALUES ($1, $2, $3, $4::jsonb, $5, true)
         ON CONFLICT (key) DO UPDATE SET
           name = EXCLUDED.name,
           icon = EXCLUDED.icon,
           detail_schema = EXCLUDED.detail_schema,
           sort_order = EXCLUDED.sort_order,
           is_active = true,
           updated_at = now()`,
        [category.key, category.name, category.icon, JSON.stringify(category.detailSchema), category.sortOrder]
      );
    }
    await client.query("COMMIT");
    logger.info({ categories: categoryDefinitions.length }, "seed complete");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  logger.error({ err: error }, "seed failed");
  process.exitCode = 1;
});
