import type { PoolClient } from "pg";

// PostgreSQL session locks have no Drizzle query-builder equivalent.
// Keep these fixed, parameterized driver calls on the owning connection.
export async function tryLock(
  client: PoolClient,
  key: string,
): Promise<boolean> {
  const result = await client.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
    [key],
  );
  return result.rows[0]?.locked === true;
}
export async function lockMigrations(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
    "agent_workflows:migrations",
  ]);
}
export async function unlockAll(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_unlock_all()");
}
