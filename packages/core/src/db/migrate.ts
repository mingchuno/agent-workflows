import { Pool } from "pg";
import { migrateDatabase } from "./migrations.js";

const databaseUrl = process.env.AGENT_WORKFLOWS_DATABASE_URL;
if (!databaseUrl)
  throw new Error("Set AGENT_WORKFLOWS_DATABASE_URL to a PostgreSQL URL");
const pool = new Pool({ connectionString: databaseUrl });
try {
  await migrateDatabase(pool);
} finally {
  await pool.end();
}
