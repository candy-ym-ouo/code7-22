import { loadEnvFile } from "@map/shared/env";

loadEnvFile();

import pg from "pg";
import { categoryDefinitions } from "@map/shared/contracts";

const { Client } = pg;

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const client = new Client({ connectionString: databaseUrl });
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
    console.log(`seeded ${categoryDefinitions.length} categories`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
