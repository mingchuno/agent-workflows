import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { configSchema } from "../src/config.js";
import { Runner } from "../src/runner.js";
import { command } from "../src/runtime/process.js";
import { ExistingCheckout } from "../src/workspace.js";
import { repository } from "./fixtures.js";
import { agent, FixtureHosting, waitFor } from "./runner-fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

async function failedPublication(
  phase = "push",
  configure?: (
    fixture: Awaited<ReturnType<typeof repository>>,
  ) => Promise<void>,
) {
  const fixture = await repository();
  await configure?.(fixture);
  const stateDirectory = await mkdtemp(join(tmpdir(), "aw-publication-"));
  const validationCount = join(stateDirectory, "validation-count");
  fixture.project.validation = [
    {
      command: process.execPath,
      args: [
        "-e",
        "require('node:fs').appendFileSync(process.argv[1], 'checked\\n')",
        validationCount,
      ],
      timeoutMs: 10000,
    },
  ];
  let failing = true;
  let calls = 0;
  class Hosting extends FixtureHosting {
    override async createChange(
      input: Parameters<FixtureHosting["createChange"]>[0],
    ) {
      if (phase === "change-request" && failing) {
        calls++;
        throw new Error("Hosting unavailable");
      }
      return super.createChange(input);
    }
    override async publishReview(
      input: Parameters<FixtureHosting["publishReview"]>[0],
    ) {
      if (phase === "review-publication" && failing) {
        calls++;
        throw new Error("Hosting unavailable");
      }
      return super.publishReview(input);
    }
  }
  class Checkout extends ExistingCheckout {
    override async push(...args: Parameters<ExistingCheckout["push"]>) {
      if (phase === "push" && failing) {
        calls++;
        throw new Error("Remote unavailable");
      }
      return super.push(...args);
    }
  }
  const hosting = new Hosting();
  const runner = new Runner({
    config: configSchema.parse({
      id: "publication_" + randomUUID().replaceAll("-", ""),
      stateDirectory,
      projects: [fixture.project],
    }),
    databaseUrl: databaseUrl!,
    hosting: () => hosting,
    agents: { codex: agent },
    workspace: new Checkout(),
  });
  await runner.start();
  await waitFor(
    async () => (await runner.store.runs())[0]?.outcome === "failed",
  );
  // Wait for DBOS to persist the terminal checkpoint before admitting recovery.
  const run = (await runner.store.runs())[0]!;
  await waitFor(
    async () => (await DBOS.getWorkflowStatus(run.id))?.status === "SUCCESS",
  );
  assert.equal(calls, 3);
  return {
    ...fixture,
    runner,
    hosting,
    run,
    validationCount,
    calls: () => calls,
    restore: () => {
      failing = false;
    },
  };
}

for (const phase of ["push", "change-request", "review-publication"]) {
  test(`recover ${phase} reuses completed steps and preserves run identity`, {
    skip: !databaseUrl,
  }, async () => {
    const { runner, hosting, run, restore, git, validationCount } =
      await failedPublication(phase);
    try {
      const sessions = await runner.store.invocations(run.id);
      restore();
      // The effect may have succeeded even though all responses were lost.
      if (phase === "push")
        await git("push", "origin", `${run.head}:refs/heads/${run.branch}`);
      if (phase === "change-request")
        await hosting.createChange({
          branch: run.branch,
          base: "main",
          head: run.head!,
          issue: run.issue,
          publication: run.publication!,
          runId: run.id,
        });
      if (phase === "review-publication")
        await hosting.publishReview({
          change: run.change!,
          head: run.head!,
          review: run.review!,
          runId: run.id,
          diff: "",
        });
      const executionId = await runner.recover(run.id);
      await waitFor(
        async () => (await runner.store.run(run.id)).outcome === "completed",
      );
      const recovered = await runner.store.run(run.id);
      assert.equal((await runner.store.runs()).length, 1);
      assert.equal(recovered.branch, run.branch);
      assert.equal(recovered.head, run.head);
      assert.equal(recovered.attempt, 1);
      assert.equal(recovered.error, undefined);
      assert.equal(recovered.executions?.length, 2);
      assert.equal(recovered.executions?.[0]?.outcome, "failed");
      assert.equal(recovered.executions?.[1]?.id, executionId);
      assert.equal(recovered.executions?.[1]?.outcome, "completed");
      assert.equal(
        recovered.executions?.[0]?.finishedAt,
        run.executions?.[0]?.finishedAt,
      );
      const timing = recovered.executions![1]!;
      assert.ok(timing.startedAt && timing.finishedAt);
      assert.ok(Date.parse(timing.startedAt) >= Date.parse(timing.createdAt));
      assert.ok(Date.parse(timing.finishedAt) >= Date.parse(timing.startedAt));
      assert.equal(await readFile(validationCount, "utf8"), "checked\n");
      const completedSessions = await runner.store.invocations(run.id);
      assert.equal(completedSessions.length, 3);
      for (const session of sessions)
        assert.ok(completedSessions.some((item) => item.id === session.id));
      assert.equal(hosting.changes.length, 1);
      assert.deepEqual(hosting.reviews, [run.id]);
      assert.equal(
        Number((await git("rev-list", "--count", "HEAD")).stdout),
        2,
      );
    } finally {
      await runner.shutdown();
    }
  });
}

test("recovery admission is idempotent, respects pause, and excludes retry", {
  skip: !databaseUrl,
}, async () => {
  const { runner, run, restore } = await failedPublication();
  try {
    await runner.pause(run.projectId);
    restore();
    const id = randomUUID();
    assert.deepEqual(
      await Promise.all([
        runner.recover(run.id, id),
        runner.recover(run.id, id),
      ]),
      [id, id],
    );
    await assert.rejects(runner.retry(run.id));
    await assert.rejects(runner.recover(run.id));
    assert.equal((await runner.store.run(run.id)).outcome, "queued");
    await runner.resume(run.projectId);
    await waitFor(
      async () => (await runner.store.run(run.id)).outcome === "completed",
    );
    assert.equal(await runner.recover(run.id, id), id);
    assert.equal((await runner.store.run(run.id)).executions?.length, 2);
  } finally {
    await runner.shutdown();
  }
});

test("CLI queues recovery and inspect exposes its execution history", {
  skip: !databaseUrl,
}, async () => {
  const { runner, run, restore } = await failedPublication();
  try {
    await runner.pause(run.projectId);
    restore();
    const configPath = join(runner.config.stateDirectory, "config.json");
    await writeFile(configPath, JSON.stringify(runner.config));
    const cli = (...args: string[]) =>
      command(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "--config", configPath, ...args],
        {
          cwd: process.cwd(),
          env: { ...process.env, AGENT_WORKFLOWS_DATABASE_URL: databaseUrl! },
        },
      );
    const before = JSON.parse((await cli("inspect", run.id)).stdout);
    assert.equal(before.recovery.eligible, true);
    assert.equal(before.recovery.fromStep, "push");
    const requested = JSON.parse((await cli("recover", run.id)).stdout);
    await waitFor(
      async () =>
        (await runner.store.commands()).find(
          (item) => item.id === requested.commandId,
        )?.status === "success",
    );
    const after = JSON.parse((await cli("inspect", run.id)).stdout);
    assert.equal(after.run.executions[1].id, requested.commandId);
    assert.equal(after.run.executions[1].recoveryOf, run.id);
    assert.ok(after.run.executions[1].reusedSteps.includes("validation"));
    // Cancelling admitted recovery must address its new execution, not its source.
    await runner.stop(run.id);
    assert.equal((await runner.store.run(run.id)).outcome, "cancelled");
    assert.equal((await DBOS.getWorkflowStatus(run.id))?.status, "SUCCESS");
    await assert.rejects(runner.recover(run.id), /Only failed/);
  } finally {
    await runner.shutdown();
  }
});

test("a failed recovery gets three new attempts and can be recovered again", {
  skip: !databaseUrl,
}, async () => {
  const { runner, run, restore, calls } = await failedPublication();
  try {
    const first = await runner.recover(run.id);
    await waitFor(
      async () => (await runner.store.run(run.id)).outcome === "failed",
    );
    await waitFor(
      async () => (await DBOS.getWorkflowStatus(first))?.status === "SUCCESS",
    );
    assert.equal(calls(), 6);
    restore();
    await runner.recover(run.id);
    await waitFor(
      async () => (await runner.store.run(run.id)).outcome === "completed",
    );
    assert.deepEqual(
      (await runner.store.run(run.id)).executions?.map((item) => item.outcome),
      ["failed", "failed", "completed"],
    );
    assert.equal((await runner.store.invocations(run.id)).length, 3);
  } finally {
    await runner.shutdown();
  }
});

test("recovery rechecks checkout after admission before reusing checkpoints", {
  skip: !databaseUrl,
}, async () => {
  const { runner, run, restore, root, hosting } = await failedPublication();
  try {
    await runner.pause(run.projectId);
    restore();
    await runner.recover(run.id);
    await writeFile(join(root, "unexpected.txt"), "preserve me");
    await runner.resume(run.projectId);
    await waitFor(
      async () => (await runner.store.run(run.id)).outcome === "blocked",
    );
    assert.match((await runner.store.run(run.id)).error!, /clean|changed/);
    assert.equal(hosting.changes.length, 0);
    assert.equal(
      await readFile(join(root, "unexpected.txt"), "utf8"),
      "preserve me",
    );
  } finally {
    await runner.shutdown();
  }
});

test("a fork with a copied start gate still honors pause and preserves a later project block", {
  skip: !databaseUrl,
}, async () => {
  const { runner, run, restore, hosting } = await failedPublication();
  try {
    await runner.pause(run.projectId);
    restore();
    const id = await runner.recover(run.id);
    // Simulate dispatch having persisted the fork just before pause was accepted.
    const source = (await DBOS.getWorkflowStatus(run.id))!;
    await DBOS.forkWorkflow(run.id, run.failedStep!, {
      newWorkflowID: id,
      queueName: source.queueName!,
    });
    await waitFor(
      async () => (await DBOS.getWorkflowStatus(id))?.status === "PENDING",
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal((await runner.store.run(run.id)).outcome, "queued");
    assert.equal(hosting.changes.length, 0);
    await runner.store.setProject(run.projectId, {
      blocked: "Another operation needs attention",
    });
    await waitFor(
      async () => (await runner.store.run(run.id)).outcome === "blocked",
    );
    assert.equal(
      (await runner.store.project(run.projectId)).blocked,
      "Another operation needs attention",
    );
    assert.equal(hosting.changes.length, 0);
  } finally {
    await runner.shutdown();
  }
});

test("configuration, artifacts, remote revision and checkpoint loss refuse recovery", {
  skip: !databaseUrl,
}, async () => {
  const { runner, run, git } = await failedPublication();
  try {
    const project = runner.config.projects[0]!;
    project.stages.review.prompt = "changed";
    await assert.rejects(runner.recover(run.id), /configuration|skills/);
    delete project.stages.review.prompt;
    const log = (await runner.store.invocations(run.id))[0]!.log;
    const contents = await readFile(log);
    await unlink(log);
    await assert.rejects(runner.recover(run.id), /artifact unavailable/);
    await writeFile(log, contents);
    await git("push", "origin", `${run.base}:refs/heads/${run.branch}`);
    await assert.rejects(runner.recover(run.id), /remote revision changed/);
    await git("push", "origin", `:refs/heads/${run.branch}`);
    // Removing a successful checkpoint must never cause that step to execute again.
    await runner.store.pool.query(
      "DELETE FROM dbos.operation_outputs WHERE workflow_uuid = $1 AND function_name = 'validation'",
      [run.id],
    );
    await assert.rejects(runner.recover(run.id), /checkpoints are unavailable/);
    assert.equal((await runner.store.run(run.id)).executions?.length, 1);
  } finally {
    await runner.shutdown();
  }
});

test("competing fresh retry and recovery admit only one continuation", {
  skip: !databaseUrl,
}, async () => {
  const { runner, run } = await failedPublication();
  try {
    await runner.pause(run.projectId);
    const results = await Promise.allSettled([
      runner.recover(run.id),
      runner.retry(run.id),
    ]);
    assert.equal(
      results.filter((item) => item.status === "fulfilled").length,
      1,
    );
    const runs = await runner.store.runs();
    assert.equal(runs.filter((item) => item.outcome === "queued").length, 1);
    if (runs.length > 1) {
      await runner.store.patchRun(runs[1]!.id, { outcome: "failed" });
      await assert.rejects(runner.recover(run.id), /superseded/);
    }
  } finally {
    await runner.shutdown();
  }
});

test("recovery refuses changed files and unrelated project blocks without mutation", {
  skip: !databaseUrl,
}, async () => {
  const { runner, run, root } = await failedPublication();
  try {
    await runner.store.setProject(run.projectId, {
      blocked: "Unrelated owner problem",
    });
    await assert.rejects(runner.recover(run.id), /Unrelated owner problem/);
    assert.equal(
      (await runner.store.project(run.projectId)).blocked,
      "Unrelated owner problem",
    );
    await runner.store.setProject(run.projectId, { blocked: null });
    await writeFile(join(root, "unfinished.txt"), "preserve");
    await assert.rejects(runner.recover(run.id), /clean|changed/);
    assert.equal((await runner.store.run(run.id)).executions?.length, 1);
  } finally {
    await runner.shutdown();
  }
});

test("recovery fingerprints inline prompts and allows credential rotation", {
  skip: !databaseUrl,
}, async () => {
  const { runner, run, restore } = await failedPublication(
    "push",
    async ({ root, project, git }) => {
      await writeFile(join(root, "SKILL.md"), "Use the fetched skill\n");
      await git("add", "SKILL.md");
      await git("commit", "-m", "add skill on remote base");
      await git("push", "origin", "HEAD:refs/heads/main");
      await git("reset", "--hard", "HEAD~1");
      project.stages.implementation.prompt = "Use the configured instructions";
    },
  );
  try {
    restore();
    runner.config.projects[0]!.hosting.tokenEnv = "ROTATED_FIXTURE_TOKEN";
    await runner.recover(run.id);
    await waitFor(
      async () => (await runner.store.run(run.id)).outcome === "completed",
    );
    assert.equal((await runner.store.invocations(run.id)).length, 3);
  } finally {
    await runner.shutdown();
  }
});

test("failed admission event rolls back recovery intent and can be retried", {
  skip: !databaseUrl,
}, async () => {
  const { runner, run, restore } = await failedPublication();
  try {
    await runner.pause(run.projectId);
    const id = randomUUID();
    await runner.store.pool.query(
      "ALTER TABLE agent_workflows.events ADD CONSTRAINT publication_recovery_event_failure CHECK (kind <> 'recovery') NOT VALID",
    );
    try {
      await assert.rejects(runner.recover(run.id, id), (error: Error) =>
        /publication_recovery_event_failure/.test(String(error.cause ?? error)),
      );
      const unchanged = await runner.store.run(run.id);
      assert.equal(unchanged.outcome, "failed");
      assert.equal(unchanged.executions?.length, 1);
      assert.equal(await DBOS.getWorkflowStatus(id), null);
    } finally {
      await runner.store.pool.query(
        "ALTER TABLE agent_workflows.events DROP CONSTRAINT publication_recovery_event_failure",
      );
    }
    restore();
    assert.equal(await runner.recover(run.id, id), id);
    await runner.resume(run.projectId);
    await waitFor(
      async () => (await runner.store.run(run.id)).outcome === "completed",
    );
  } finally {
    await runner.shutdown();
  }
});
