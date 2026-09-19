import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { RunRecord } from "../src/domain.js";
import { type InvocationRecord, Store } from "../src/store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
function run(scope: string, number = 1, attempt = 1): RunRecord {
  return {
    id: randomUUID(),
    projectId: "project",
    checkout: "/tmp/fixture",
    taskKey: `${scope}:${number}`,
    attempt,
    issue: {
      id: String(number),
      number,
      title: "secret",
      body: "",
      url: "",
      labels: [],
      open: true,
    },
    outcome: "queued",
    phase: "queued",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    branch: "fixture",
  };
}

test("store preserves scoped records, uniqueness, numeric ordering and concurrent patches", {
  skip: !databaseUrl,
}, async () => {
  const scope = randomUUID();
  const store = new Store(databaseUrl!, scope, (text) =>
    text.replaceAll("secret", "[REDACTED]"),
  );
  const other = new Store(databaseUrl!, randomUUID());
  try {
    await store.initialize();
    await store.initialize();
    await store.registerProject("project");
    await store.registerProject("project");
    await store.setProject("project", { paused: true, blocked: "reason" });
    await store.setProject("project", { blocked: null });
    assert.deepEqual(await store.project("project"), {
      id: "project",
      paused: true,
      blocked: null,
    });
    assert.deepEqual(await other.projects(), []);
    const ten = run(scope, 10),
      two = run(scope, 2),
      retry = run(scope, 2, 2);
    for (const record of [ten, retry, two])
      assert.equal(await store.insertRun(record), true);
    assert.equal(await store.insertRun({ ...two, id: randomUUID() }), false);
    assert.deepEqual(
      (await store.runs()).map((record) => record.id),
      [two.id, retry.id, ten.id],
    );
    await Promise.all([
      store.patchRun(two.id, { phase: "implementation" }),
      store.patchRun(two.id, { error: "secret" }),
    ]);
    const updated = await store.run(two.id);
    assert.equal(updated.phase, "implementation");
    assert.equal(updated.error, "[REDACTED]");
    assert.equal(updated.issue.title, "[REDACTED]");
    await assert.rejects(other.run(two.id), /Unknown run/);
    await assert.rejects(
      other.patchRun(two.id, { phase: "wrong" }),
      /Unknown run/,
    );
    const invocation: InvocationRecord = {
      id: randomUUID(),
      runId: two.id,
      projectId: "project",
      step: "implementation",
      stepId: 1,
      attempt: 1,
      provider: "fixture",
      sessionId: null,
      sessionState: "pending",
      requested: {},
      effective: {},
      prompt: "secret",
      skills: [],
      outcome: "running",
      startedAt: two.createdAt,
      log: "fixture",
    };
    await store.saveInvocation(invocation);
    await store.saveInvocation({ ...invocation, outcome: "completed" });
    assert.equal((await store.invocations(two.id)).length, 1);
    assert.equal((await store.invocations(two.id))[0]?.prompt, "[REDACTED]");
    assert.equal((await store.invocations(two.id))[0]?.outcome, "completed");
    assert.deepEqual(await other.invocations(two.id), []);
    await store.emit(two.id, "nullable", null);
    assert.equal((await store.events(0, two.id)).at(-1)?.payload, null);
    const events = await store.events(0, two.id);
    assert.ok(events.length > 0);
    assert.equal(typeof events[0]?.sequence, "number");
    assert.equal(
      new Date(events[0]!.createdAt).toISOString(),
      events[0]?.createdAt,
    );
    assert.deepEqual(await store.events(events.at(-1)!.sequence, two.id), []);
    assert.deepEqual(await other.events(), []);
    const command = await store.request("pause", "project");
    await store.finishCommand(command, "failed");
    assert.deepEqual(await store.commands(), [
      {
        id: command,
        kind: "pause",
        target: "project",
        status: "failed",
        error: "failed",
      },
    ]);
    assert.deepEqual(await other.commands(), []);
  } finally {
    await store.close();
    await other.close();
  }
});
