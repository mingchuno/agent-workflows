import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";
import { lockMigrations, unlockAll } from "./locks.js";

export async function migrateDatabase(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await lockMigrations(client);
    await migrate(drizzle(client), {
      migrationsFolder: fileURLToPath(
        new URL("../../drizzle", import.meta.url),
      ),
      migrationsSchema: "agent_workflows_migrations",
    });
  } finally {
    try {
      await unlockAll(client);
    } finally {
      client.release(true);
    }
  }
}
