import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configSchema } from "../src/config.js";
import type {
  AgentAdapter,
  AgentInvocation,
  ReviewRequest,
} from "../src/domain.js";
import { Runner } from "../src/runner.js";
import { repository } from "./fixtures.js";
import { agent, FixtureHosting, waitFor } from "./runner-fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
async function setup(controlled: AgentAdapter = agent, rereviewOnPush = false) {
  const { project, git, root } = await repository();
  const base = (await git("rev-parse", "HEAD")).stdout.trim();
  await git("switch", "-c", "feature");
  await writeFile(join(root, "file.txt"), "base\nreview me\n");
  await git("add", "file.txt");
  await git("commit", "-m", "feat: change file");
  await git("push", "origin", "feature");
  const head = (await git("rev-parse", "HEAD")).stdout.trim();
  await git("switch", "main");
  project.pollIntervalMs = 3_600_000;
  project.workflows.implementation.enabled = false;
  project.workflows.review.enabled = true;
  project.workflows.review.rereviewOnPush = rereviewOnPush;
  const request: ReviewRequest = {
    id: "42",
    number: 7,
    title: "Review this change",
    body: "Requirements in the MR",
    url: "https://fixture.invalid/pr/7",
    labels: ["ready-for-review"],
    open: true,
    draft: false,
    fork: false,
    sourceBranch: "feature",
    targetBranch: "main",
    base,
    start: base,
    change: { id: 7, url: "https://fixture.invalid/pr/7", head },
  };
  const hosting = new FixtureHosting();
  hosting.requests = [request];
  const config = configSchema.parse({
    id: "review_" + randomUUID().replaceAll("-", ""),
    stateDirectory: await mkdtemp(join(tmpdir(), "aw-review-")),
    projects: [project],
  });
  const options = {
    config,
    databaseUrl: databaseUrl!,
    hosting: () => hosting,
    agents: { codex: controlled },
  };
  const runner = new Runner(options);
  return { runner, hosting, request, git, root, options };
}
async function finished(runner: Runner, count = 1) {
  await waitFor(async () => {
    const runs = await runner.store.runs();
    return (
      runs.length === count &&
      runs.every((run) => !["queued", "running"].includes(run.outcome))
    );
  });
  return runner.store.runs();
}

test("review-only intake excludes drafts and forks and uses a fresh structured reviewer", {
  skip: !databaseUrl,
}, async () => {
  const calls: AgentInvocation[] = [];
  const fixture = await setup({
    validate: agent.validate,
    async invoke(input) {
      calls.push(input);
      assert.equal(input.step, "review");
      assert.equal(input.resumeSessionId, undefined);
      assert.ok(input.outputSchema);
      assert.match(input.prompt, /Change request:.*Requirements in the MR/);
      return agent.invoke(input);
    },
  });
  const { runner, hosting, request, git } = fixture;
  hosting.requests.push(
    ...[{ draft: true }, { fork: true }, { open: false }, { labels: [] }].map(
      (override, index) => ({
        ...request,
        ...override,
        id: String(index + 100),
        number: index + 100,
      }),
    ),
  );
  try {
    await runner.start();
    const [run] = await finished(runner);
    assert.equal(run!.outcome, "completed", run!.error ?? "unexpected outcome");
    assert.equal(run!.subject.kind, "change-request");
    assert.equal(run!.validation, undefined);
    assert.equal(run!.publication, undefined);
    assert.equal(hosting.changes.length, 0);
    assert.equal(hosting.reviews.length, 1);
    assert.equal(calls.length, 1);
    assert.equal(
      (await git("rev-parse", "HEAD")).stdout.trim(),
      request.change.head,
    );
    assert.equal((await git("status", "--porcelain")).stdout, "");
    await runner.poll();
    assert.equal((await runner.store.runs()).length, 1);
  } finally {
    await runner.shutdown();
  }
});

for (const enabled of [false, true]) {
  test(`new pushes ${enabled ? "admit" : "do not admit"} another review and polling survives restart`, {
    skip: !databaseUrl,
  }, async () => {
    const { runner, hosting, request, git, root, options } = await setup(
      agent,
      enabled,
    );
    try {
      await runner.start();
      await finished(runner);
    } finally {
      await runner.shutdown();
    }
    await git("switch", "feature");
    await writeFile(join(root, "file.txt"), "base\nreview me\nnew push\n");
    await git("add", "file.txt");
    await git("commit", "-m", "feat: update review");
    await git("push", "origin", "feature");
    hosting.requests[0] = {
      ...request,
      change: {
        ...request.change,
        head: (await git("rev-parse", "HEAD")).stdout.trim(),
      },
    };
    const restarted = new Runner(options);
    try {
      await restarted.start();
      await restarted.poll();
      const runs = await finished(restarted, enabled ? 2 : 1);
      assert.ok(runs.every((run) => run.outcome === "completed"));
      assert.equal(hosting.reviews.length, enabled ? 2 : 1);
      await restarted.poll();
      assert.equal((await restarted.store.runs()).length, enabled ? 2 : 1);
    } finally {
      await restarted.shutdown();
    }
  });
}

test("a push during review supersedes findings without blocking the project", {
  skip: !databaseUrl,
}, async () => {
  let fixture: Awaited<ReturnType<typeof setup>>;
  fixture = await setup({
    validate: agent.validate,
    async invoke(input) {
      fixture.hosting.requests[0] = {
        ...fixture.request,
        change: { ...fixture.request.change, head: "changed" },
      };
      return agent.invoke(input);
    },
  });
  try {
    await fixture.runner.start();
    const [run] = await finished(fixture.runner);
    assert.equal(
      run!.outcome,
      "superseded",
      run!.error ?? "unexpected outcome",
    );
    assert.equal(fixture.hosting.reviews.length, 0);
    assert.equal((await fixture.runner.store.project("fixture")).blocked, null);
  } finally {
    await fixture.runner.shutdown();
  }
});

test("review publication rejects a missing identity before hosting effects", {
  skip: !databaseUrl,
}, async () => {
  const fixture = await setup({
    validate: agent.validate,
    async invoke(input) {
      await fixture.runner.store.pool.query(
        "UPDATE agent_workflows.runs SET record = record - 'reviewPublicationId' WHERE id = $1",
        [input.runId],
      );
      return agent.invoke(input);
    },
  });
  try {
    await fixture.runner.start();
    const [run] = await finished(fixture.runner);
    assert.equal(run!.outcome, "blocked");
    assert.match(run!.error!, /Review run is missing its publication identity/);
    assert.equal(fixture.hosting.reviews.length, 0);
  } finally {
    await fixture.runner.shutdown();
  }
});

test("review publication retry reuses retained output and reconciles response loss", {
  skip: !databaseUrl,
}, async () => {
  let invocations = 0;
  const { runner, hosting } = await setup({
    validate: agent.validate,
    async invoke(input) {
      invocations++;
      return agent.invoke(input);
    },
  });
  const publish = hosting.publishReview.bind(hosting);
  hosting.publishReview = async (input) => {
    await publish(input);
    throw new Error("Response lost");
  };
  try {
    await runner.start();
    const [failed] = await finished(runner);
    assert.equal(failed!.outcome, "failed");
    assert.equal(hosting.reviews.length, 1);
    await assert.rejects(runner.recover(failed!.id), /use retry/);
    hosting.publishReview = publish;
    // Inject a malformed persisted record; normal creation always sets this field.
    await runner.store.pool.query(
      "UPDATE agent_workflows.runs SET record = record - 'reviewPublicationId' WHERE id = $1",
      [failed!.id],
    );
    await assert.rejects(
      runner.retry(failed!.id),
      /Review run is missing its publication identity/,
    );
    assert.equal((await runner.store.runs()).length, 1);
    await runner.store.patchRun(failed!.id, {
      reviewPublicationId: failed!.reviewPublicationId,
    });
    await runner.retry(failed!.id);
    const runs = await finished(runner, 2);
    assert.equal(runs.find((run) => run.retryOf)!.outcome, "completed");
    assert.equal(invocations, 1);
    assert.equal(hosting.reviews.length, 1);
    assert.equal(runs[0]!.reviewPublicationId, runs[1]!.reviewPublicationId);
  } finally {
    await runner.shutdown();
  }
});

for (const failure of ["incomplete", "mutation", "correction"] as const) {
  test(`review-only structured session handles ${failure}`, {
    skip: !databaseUrl,
  }, async () => {
    let calls = 0;
    const { runner, hosting } = await setup({
      validate: agent.validate,
      async invoke(input) {
        calls++;
        await input.session(input.resumeSessionId ?? "review-session");
        if (failure === "incomplete")
          return JSON.stringify({
            complete: false,
            limitations: ["Missing context"],
            summary: "Partial",
            findings: [
              { body: "Potential regression", path: null, line: null },
            ],
          });
        if (failure === "mutation")
          await writeFile(join(input.cwd, "file.txt"), "unexpected mutation");
        if (failure === "correction" && calls === 1) return "invalid JSON";
        return agent.invoke(input);
      },
    });
    try {
      await runner.start();
      const [run] = await finished(runner);
      assert.equal(
        run!.outcome,
        failure === "correction" ? "completed" : "blocked",
        run!.error ?? "unexpected outcome",
      );
      assert.equal(hosting.reviews.length, failure === "correction" ? 1 : 0);
      assert.equal(calls, failure === "correction" ? 2 : 1);
      if (failure === "incomplete")
        assert.equal(run!.review!.findings.length, 1);
    } finally {
      await runner.shutdown();
    }
  });
}

test("queued review rechecks completed implementation reviews before invoking another reviewer", {
  skip: !databaseUrl,
}, async () => {
  let calls = 0;
  const { runner, hosting, request } = await setup({
    validate: agent.validate,
    async invoke(input) {
      calls++;
      return agent.invoke(input);
    },
  });
  let recorded = false;
  hosting.listChanges = async () => {
    if (!recorded) {
      recorded = true;
      await runner.store.insertRun({
        id: randomUUID(),
        projectId: "fixture",
        checkout: runner.config.projects[0]!.checkout,
        taskKey: "already-implemented",
        attempt: 1,
        subject: { ...hosting.issues[0]!, kind: "issue" },
        outcome: "completed",
        phase: "completion",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        branch: "main",
        change: request.change,
        reviewHead: request.change.head,
        review: {
          complete: true,
          limitations: [],
          summary: "Existing review",
          findings: [],
        },
      });
    }
    return [request];
  };
  try {
    await runner.start();
    const runs = await finished(runner, 2);
    assert.equal(
      runs.find((run) => run.subject.kind === "change-request")!.outcome,
      "ineligible",
    );
    assert.equal(calls, 0);
  } finally {
    await runner.shutdown();
  }
});

test("review of a renamed file includes the original path in the publication diff", {
  skip: !databaseUrl,
}, async () => {
  const { runner, hosting, request, git, root } = await setup({
    validate: agent.validate,
    async invoke(input) {
      await input.session("rename-review");
      return JSON.stringify({
        complete: true,
        limitations: [],
        summary: "Rename review",
        findings: [{ body: "Check added line", path: "renamed.txt", line: 3 }],
      });
    },
  });
  await git("switch", "-c", "renamed-feature", "feature");
  await git("mv", "file.txt", "renamed.txt");
  await writeFile(join(root, "renamed.txt"), "base\nreview me\nnew line\n");
  await git("add", "renamed.txt");
  await git("commit", "-m", "feat: rename file");
  await git("push", "origin", "renamed-feature");
  hosting.requests[0] = {
    ...request,
    base: request.change.head,
    start: request.change.head,
    targetBranch: "feature",
    sourceBranch: "renamed-feature",
    change: {
      ...request.change,
      head: (await git("rev-parse", "HEAD")).stdout.trim(),
    },
  };
  const publish = hosting.publishReview.bind(hosting);
  let diff = "";
  hosting.publishReview = async (input) => {
    diff = input.diff;
    await publish(input);
  };
  try {
    await runner.start();
    const [run] = await finished(runner);
    assert.equal(run!.outcome, "completed", run!.error ?? "unexpected outcome");
    assert.match(diff, /--- a\/file.txt/);
    assert.match(diff, /\+\+\+ b\/renamed.txt/);
  } finally {
    await runner.shutdown();
  }
});

test("review eligibility does not retarget a queued run to a different request identity", {
  skip: !databaseUrl,
}, async () => {
  let calls = 0;
  const { runner, hosting, request } = await setup({
    validate: agent.validate,
    async invoke(input) {
      calls++;
      return agent.invoke(input);
    },
  });
  hosting.getChange = async () => ({
    ...request,
    id: "different-repository-request",
    url: "https://fixture.invalid/other/pr/7",
  });
  try {
    await runner.start();
    const [run] = await finished(runner);
    assert.equal(run!.outcome, "superseded");
    assert.equal(calls, 0);
    assert.equal(hosting.reviews.length, 0);
  } finally {
    await runner.shutdown();
  }
});
