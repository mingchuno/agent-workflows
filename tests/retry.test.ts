import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configSchema } from "../src/config.js";
import type { RunRecord } from "../src/domain.js";
import { Runner } from "../src/runner.js";
import { repository } from "./fixtures.js";
import { FixtureHosting, waitFor } from "./runner-fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
async function setup(scopePrefix = "retry") {
  const { root, project } = await repository();
  const hosting = new FixtureHosting();
  const config = configSchema.parse({
    id: scopePrefix + "_" + randomUUID().replaceAll("-", ""),
    stateDirectory: await mkdtemp(join(tmpdir(), "aw-retry-")),
    projects: [project],
  });
  // Exercise public retry admission without starting workflow dispatch.
  const runner = new Runner({
    config,
    databaseUrl: databaseUrl!,
    hosting: () => hosting,
    agents: {},
  });
  await runner.store.initialize();
  await runner.store.registerProject(project.id);
  const original: RunRecord = {
    id: randomUUID(),
    projectId: project.id,
    checkout: root,
    taskKey: `${hosting.identity}:1`,
    attempt: 1,
    issue: hosting.issues[0]!,
    outcome: "failed",
    phase: "implementation",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    branch: "agent/1-1",
  };
  await runner.store.insertRun(original);
  await runner.store.setProject(project.id, {
    blocked: "Preserve recovery evidence",
    paused: true,
  });
  return { runner, original, root, project, hosting };
}

test("refresh retry snapshots the current issue and selected validation profile", {
  skip: !databaseUrl,
}, async () => {
  const { runner, original, hosting, project } = await setup();
  try {
    runner.config.projects[0]!.validationProfiles.migration = [
      { command: "pnpm", args: ["test:migrations"], timeoutMs: 300000 },
    ];
    hosting.issues[0] = {
      ...hosting.issues[0]!,
      title: "Revised task",
      body: "Revised instructions\n\n```agent-workflows-validation\nmigration\n```",
    };
    const id = await runner.retry(original.id, undefined, {
      refreshIssue: true,
    });
    const retried = await runner.store.run(id);
    assert.equal(retried.issue.title, "Revised task");
    assert.equal(retried.issue.body, hosting.issues[0]!.body);
    assert.equal(
      (await runner.store.run(original.id)).issue.body,
      original.issue.body,
    );
    hosting.issues[0]!.body = "Changed again";
    assert.match((await runner.store.run(id)).issue.body, /migration/);
    assert.equal((await runner.store.project(project.id)).blocked, null);
  } finally {
    await runner.store.close();
  }
});

test("plain retry retains the recorded issue after hosted edits", {
  skip: !databaseUrl,
}, async () => {
  const { runner, original, hosting } = await setup();
  try {
    hosting.issues[0]!.body = "New hosted instructions";
    const id = await runner.retry(original.id);
    assert.equal((await runner.store.run(id)).issue.body, "Implement the task");
  } finally {
    await runner.store.close();
  }
});

test("refresh retry rejects ineligible issues and invalid validation selections", {
  skip: !databaseUrl,
}, async () => {
  const { runner, original, hosting, project } = await setup();
  try {
    const refresh = () =>
      runner.retry(original.id, undefined, { refreshIssue: true });
    hosting.issues[0]!.open = false;
    await assert.rejects(refresh(), /closed or missing required labels/);
    hosting.issues[0]!.open = true;
    hosting.issues[0]!.labels = [];
    await assert.rejects(refresh(), /closed or missing required labels/);
    hosting.issues[0]!.labels = [...project.labels];
    hosting.issues[0]!.body = "```agent-workflows-validation\nmissing\n```";
    await assert.rejects(refresh(), /Unknown validation profile/);
    hosting.issues[0]!.body = "Updated";
    hosting.issues[0]!.id = "replacement";
    await assert.rejects(refresh(), /identity differs/);
    assert.equal((await runner.store.runs()).length, 1);
    assert.equal(
      (await runner.store.project(project.id)).blocked,
      "Preserve recovery evidence",
    );
  } finally {
    await runner.store.close();
  }
});

test("refresh command replay retains the admitted issue snapshot", {
  skip: !databaseUrl,
}, async () => {
  const { runner, original, hosting } = await setup();
  try {
    const commandId = randomUUID();
    hosting.issues[0]!.body = "First revision";
    assert.equal(
      await runner.retry(original.id, commandId, { refreshIssue: true }),
      commandId,
    );
    hosting.issues[0]!.body = "Second revision";
    hosting.issues[0]!.open = false;
    assert.equal(
      await runner.retry(original.id, commandId, { refreshIssue: true }),
      commandId,
    );
    assert.equal(
      (await runner.store.run(commandId)).issue.body,
      "First revision",
    );
  } finally {
    await runner.store.close();
  }
});

test("competing retry requests admit exactly one persisted attempt", {
  skip: !databaseUrl,
}, async () => {
  const { runner, original, project } = await setup();
  const guard = await runner.store.pool.connect();
  let pending: Promise<PromiseSettledResult<string>[]> | undefined;
  try {
    await guard.query("BEGIN");
    await guard.query(
      "SELECT id FROM agent_workflows.projects WHERE scope = $1 AND id = $2 FOR UPDATE",
      [runner.config.id, project.id],
    );
    pending = Promise.allSettled([
      runner.retry(original.id),
      runner.retry(original.id),
    ]);
    // Hold both requests at project persistence so this race is deterministic.
    await waitFor(async () => {
      const result = await runner.store.pool.query<{ count: string }>(
        `SELECT count(*) FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'
         AND query LIKE '%"agent_workflows"."projects"%'`,
      );
      return Number(result.rows[0]!.count) === 2;
    });
    await guard.query("COMMIT");
    const results = await pending;
    const accepted = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(accepted.length, 1);
    assert.equal(rejected.length, 1);
    assert.match(String(rejected[0]!.reason), /queued or active retry/);
    const retry = await runner.store.run(accepted[0]!.value);
    assert.equal(retry.retryOf, original.id);
    assert.equal(retry.attempt, 2);
    assert.equal(retry.branch, "agent/1-2");
    assert.equal((await runner.store.runs()).length, 2);
    assert.deepEqual(await runner.store.project(project.id), {
      id: project.id,
      paused: true,
      blocked: null,
    });
  } finally {
    await guard.query("ROLLBACK");
    await pending;
    guard.release();
    await runner.store.close();
  }
});

test("concurrent command replay returns one retry and emits admission events once", {
  skip: !databaseUrl,
}, async () => {
  const { runner, original, root, project } = await setup();
  try {
    const commandId = randomUUID();
    const cursor = (await runner.store.events()).at(-1)!.sequence;
    assert.deepEqual(
      await Promise.all([
        runner.retry(original.id, commandId),
        runner.retry(original.id, commandId),
      ]),
      [commandId, commandId],
    );
    const events = await runner.store.events(cursor);
    assert.equal(events.filter((event) => event.kind === "run").length, 1);
    assert.equal(events.filter((event) => event.kind === "project").length, 1);
    await runner.store.patchRun(commandId, { outcome: "completed" });
    await runner.store.setProject(project.id, { blocked: "New recovery" });
    await writeFile(join(root, "unfinished.txt"), "preserve me");
    const replayCursor = (await runner.store.events()).at(-1)!.sequence;
    assert.equal(await runner.retry(original.id, commandId), commandId);
    assert.equal(
      (await runner.store.project(project.id)).blocked,
      "New recovery",
    );
    assert.deepEqual(await runner.store.events(replayCursor), []);
    assert.equal((await runner.store.runs()).length, 2);
  } finally {
    await runner.store.close();
  }
});

test("a command identity cannot be replayed for a different original run", {
  skip: !databaseUrl,
}, async () => {
  const { runner, original } = await setup();
  try {
    const commandId = randomUUID();
    await runner.retry(original.id, commandId);
    await runner.store.patchRun(commandId, { outcome: "failed" });
    await assert.rejects(
      runner.retry(commandId, commandId),
      /different run|identity/,
    );
  } finally {
    await runner.store.close();
  }
});

test("failed retry insertion preserves blocking and emits no admission events", {
  skip: !databaseUrl,
}, async () => {
  const { runner, original, project } = await setup();
  try {
    const collision = randomUUID();
    // IDs are global, while replay lookup must remain scoped to this runner.
    await runner.store.pool.query(
      "INSERT INTO agent_workflows.runs (scope, id, task_key, attempt, record) VALUES ($1, $2, $3, $4, $5)",
      [randomUUID(), collision, original.taskKey, 1, original],
    );
    const cursor = (await runner.store.events()).at(-1)!.sequence;
    await assert.rejects(runner.retry(original.id, collision));
    assert.equal((await runner.store.runs()).length, 1);
    assert.equal(
      (await runner.store.project(project.id)).blocked,
      "Preserve recovery evidence",
    );
    assert.deepEqual(await runner.store.events(cursor), []);
  } finally {
    await runner.store.close();
  }
});

test("retry safety failure leaves admission state unchanged", {
  skip: !databaseUrl,
}, async () => {
  const { runner, original, project, root } = await setup();
  try {
    await writeFile(join(root, "unfinished.txt"), "preserve me");
    const cursor = (await runner.store.events()).at(-1)!.sequence;
    await assert.rejects(runner.retry(original.id), /clean/);
    assert.equal((await runner.store.runs()).length, 1);
    assert.equal(
      (await runner.store.project(project.id)).blocked,
      "Preserve recovery evidence",
    );
    assert.deepEqual(await runner.store.events(cursor), []);
  } finally {
    await runner.store.close();
  }
});

test("failed admission event rolls back the retry and project unblocking", {
  skip: !databaseUrl,
}, async () => {
  const { runner, original, project } = await setup("retry_atomic_failure");
  try {
    // A scoped database fault after the run insert tests the whole transaction.
    await runner.store.pool.query(
      `ALTER TABLE agent_workflows.events ADD CONSTRAINT retry_event_failure_fixture
       CHECK (scope NOT LIKE 'retry_atomic_failure_%' OR kind <> 'run') NOT VALID`,
    );
    const cursor = (await runner.store.events()).at(-1)!.sequence;
    await assert.rejects(runner.retry(original.id), (error: Error) =>
      /retry_event_failure_fixture/.test(String(error.cause ?? error)),
    );
    assert.equal((await runner.store.runs()).length, 1);
    assert.equal(
      (await runner.store.project(project.id)).blocked,
      "Preserve recovery evidence",
    );
    assert.deepEqual(await runner.store.events(cursor), []);
  } finally {
    await runner.store.pool.query(
      "ALTER TABLE agent_workflows.events DROP CONSTRAINT IF EXISTS retry_event_failure_fixture",
    );
    await runner.store.close();
  }
});

test("retries of different historical attempts share task admission", {
  skip: !databaseUrl,
}, async () => {
  const { runner, original } = await setup();
  try {
    const later = { ...original, id: randomUUID(), attempt: 3 };
    await runner.store.insertRun(later);
    const results = await Promise.allSettled([
      runner.retry(original.id),
      runner.retry(later.id),
    ]);
    const accepted = results.filter((result) => result.status === "fulfilled");
    assert.equal(accepted.length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.match(String(rejected?.reason), /queued or active retry/);
    assert.equal((await runner.store.run(accepted[0]!.value)).attempt, 4);
  } finally {
    await runner.store.close();
  }
});
