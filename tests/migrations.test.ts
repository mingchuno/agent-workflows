import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { escapeIdentifier, Pool } from "pg";
import type { RunRecord } from "../src/domain.js";
import { type InvocationRecord, Store } from "../src/store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
for (const legacy of [false, true]) {
  test(`migrations preserve records and serialize startup on ${legacy ? "legacy" : "fresh"} databases`, {
    skip: !databaseUrl,
  }, async () => {
    const admin = new Pool({ connectionString: databaseUrl });
    const name = "migration_test_" + randomUUID().replaceAll("-", "");
    const url = new URL(databaseUrl!);
    url.pathname = "/" + name;
    // Isolated database lifecycle and old-schema fixture intentionally use driver SQL.
    await admin.query("CREATE DATABASE " + escapeIdentifier(name));
    const store = new Store(url.toString(), "fixture");
    const observer = new Store(url.toString(), "observer");
    const existingRun: RunRecord = {
      id: randomUUID(),
      projectId: "existing",
      checkout: "/tmp/legacy",
      taskKey: "legacy:1",
      attempt: 1,
      issue: {
        id: "1",
        number: 1,
        title: "preserve",
        body: "",
        url: "",
        labels: [],
        open: true,
      },
      outcome: "queued",
      phase: "queued",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      branch: "legacy",
    };
    const existingInvocation: InvocationRecord = {
      id: randomUUID(),
      runId: existingRun.id,
      projectId: "existing",
      step: "implementation",
      stepId: 1,
      attempt: 1,
      provider: "fixture",
      sessionId: "legacy-session",
      sessionState: "available",
      requested: {},
      effective: {},
      prompt: "preserve",
      skills: [],
      outcome: "running",
      startedAt: existingRun.createdAt,
      log: "legacy.log",
    };
    try {
      await store.pool.query(
        "CREATE SCHEMA dbos; CREATE TABLE dbos.fixture (value text); INSERT INTO dbos.fixture VALUES ('untouched')",
      );
      if (legacy) {
        await store.pool.query(
          await readFile(
            new URL("./fixtures/legacy-schema.sql", import.meta.url),
            "utf8",
          ),
        );
        await store.registerProject("existing");
        await store.setProject("existing", {
          paused: true,
          blocked: "preserve",
        });
        await store.request("resume", "existing");
        await store.insertRun(existingRun);
        await store.saveInvocation(existingInvocation);
      }
      await Promise.all([store.initialize(), observer.initialize()]);
      await store.initialize();
      if (legacy) {
        assert.deepEqual(await store.project("existing"), {
          id: "existing",
          paused: true,
          blocked: "preserve",
        });
        assert.equal((await store.events()).length, 3);
        assert.deepEqual(await store.run(existingRun.id), existingRun);
        assert.deepEqual(await store.invocations(existingRun.id), [
          existingInvocation,
        ]);
        assert.equal((await store.commands()).length, 1);
      } else {
        await store.registerProject("new");
        assert.equal((await store.project("new")).paused, false);
      }
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
      // Built runtime must find shipped migrations even outside the repository cwd.
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
}

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
