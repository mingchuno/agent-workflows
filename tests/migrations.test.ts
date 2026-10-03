import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { escapeIdentifier, Pool } from "pg";
import { Store } from "../src/store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
test("migrations serialize fresh database startup and preserve records on restart", {
  skip: !databaseUrl,
}, async () => {
  const admin = new Pool({ connectionString: databaseUrl });
  const name = "migration_test_" + randomUUID().replaceAll("-", "");
  const url = new URL(databaseUrl!);
  url.pathname = "/" + name;
  await admin.query("CREATE DATABASE " + escapeIdentifier(name));
  const store = new Store(url.toString(), "fixture");
  const observer = new Store(url.toString(), "observer");
  try {
    await store.pool.query(
      "CREATE SCHEMA dbos; CREATE TABLE dbos.fixture (value text); INSERT INTO dbos.fixture VALUES ('untouched')",
    );
    await Promise.all([store.initialize(), observer.initialize()]);
    await store.registerProject("existing");
    await store.setProject("existing", { paused: true, blocked: "preserve" });
    const events = await store.events();
    await store.initialize();
    assert.deepEqual(await store.project("existing"), {
      id: "existing",
      paused: true,
      blocked: "preserve",
    });
    assert.deepEqual(await store.events(), events);
    assert.deepEqual(
      (await store.pool.query("SELECT value FROM dbos.fixture")).rows,
      [{ value: "untouched" }],
    );
    assert.equal(
      (
        await store.pool.query(
          "SELECT count(*)::integer AS count FROM agent_workflows_migrations.__drizzle_migrations",
        )
      ).rows[0].count,
      1,
    );
    // Built runtime must find shipped migrations outside the repository cwd.
    await promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL("../dist/src/db/migrate.js", import.meta.url))],
      {
        cwd: tmpdir(),
        env: { ...process.env, AGENT_WORKFLOWS_DATABASE_URL: url.toString() },
      },
    );
  } finally {
    await store.close();
    await observer.close();
    await admin.query("DROP DATABASE " + escapeIdentifier(name));
    await admin.end();
  }
});

test("database ownership rejects contenders and releases partial acquisitions", {
  skip: !databaseUrl,
}, async () => {
  const scope = randomUUID();
  const first = new Store(databaseUrl!, scope);
  const second = new Store(databaseUrl!, scope);
  const third = new Store(databaseUrl!, randomUUID());
  const checkout = randomUUID();
  try {
    await first.acquire([checkout], () => {});
    await assert.rejects(
      second.acquire([], () => {}),
      /Already owned/,
    );
    await assert.rejects(
      third.acquire([checkout], () => {}),
      /Already owned/,
    );
    await first.release();
    await second.acquire([checkout], () => {});
    await third.acquire([], () => {});
  } finally {
    await first.close();
    await second.close();
    await third.close();
  }
});
