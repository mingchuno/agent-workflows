import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { projectSchema } from "../packages/core/src/config.js";
import { Store } from "../packages/core/src/store.js";
import { submitWork } from "../packages/core/src/work/admission.js";
import { workRevision } from "../packages/core/src/work/policy.js";
import { workContractSchema } from "../packages/core/src/work/schema.js";
import { repository } from "./fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const project = projectSchema.parse({
  id: "project",
  checkout: "/tmp/fixture",
  hosting: {
    provider: "github",
    origin: "https://github.com",
    repository: "a/b",
    tokenEnv: "TOKEN",
  },
  agent: { provider: "codex" },
  sdlc: { enabled: true },
});
const contract = workContractSchema.parse({
  title: "Sort files",
  intent: "Missing sizes sort last",
  acceptanceCriteria: ["Missing sizes are last"],
  scopePaths: ["src/**"],
  verification: { strategy: "Regression test" },
  assessment: { proposedTrack: "B", complexity: "moderate" },
});

test("Work Items survive restart with stale approval rejection and atomic duplicate admission", {
  skip: !databaseUrl,
}, async () => {
  const scope = randomUUID();
  let store = new Store(databaseUrl!, scope);
  const other = new Store(databaseUrl!, randomUUID());
  try {
    await store.initialize();
    await store.registerProject(project.id);
    const work = await store.workItems.create(
      project.id,
      { kind: "local", key: "sort-files" },
      contract,
    );
    assert.equal(
      (
        await store.workItems.create(
          project.id,
          { kind: "local", key: "sort-files" },
          contract,
        )
      ).id,
      work.id,
    );
    assert.equal(
      (await store.workItems.inspect(work.id, project)).decision.state,
      "awaiting-scope-approval",
    );
    await assert.rejects(
      store.workItems.submit(work.id, work.revision, project),
      /scope approval/,
    );
    assert.equal((await store.runs()).length, 0);
    await store.workItems.approve(
      work.id,
      work.revision,
      "scope",
      { approvedBy: "operator", source: "local-operator" },
      project,
    );
    assert.equal(
      (await store.workItems.inspect(work.id, project)).decision.state,
      "ready",
    );
    await store.close();
    store = new Store(databaseUrl!, scope);
    assert.equal(
      (await store.workItems.inspect(work.id, project)).decision.state,
      "ready",
    );
    await assert.rejects(other.workItems.get(work.id), /Unknown work/);
    const submissions = await Promise.all(
      Array.from({ length: 5 }, () =>
        store.workItems.submit(work.id, work.revision, project),
      ),
    );
    assert.equal(new Set(submissions.map((run) => run.id)).size, 1);
    assert.equal((await store.runs()).length, 1);
    assert.equal(submissions[0]!.subject.kind, "local");
    assert.equal(submissions[0]!.work?.revision, work.revision);
    const edited = await store.workItems.propose(work.id, work.revision, {
      ...contract,
      acceptanceCriteria: ["Missing sizes are first"],
    });
    assert.equal((await store.workItems.approvals(work.id)).length, 1);
    assert.equal(
      (await store.workItems.inspect(work.id, project)).decision.state,
      "awaiting-scope-approval",
    );
    await assert.rejects(
      store.workItems.approve(
        work.id,
        work.revision,
        "scope",
        { approvedBy: "operator", source: "local-operator" },
        project,
      ),
      /revision changed/,
    );
    await assert.rejects(
      store.workItems.propose(work.id, work.revision, contract),
      /revision changed/,
    );
    assert.notEqual(edited.revision, work.revision);
  } finally {
    await store.close();
    await other.close();
  }
});

test("source edits require explicit reassessment and bind approval to the assessed source", {
  skip: !databaseUrl,
}, async () => {
  const store = new Store(databaseUrl!, randomUUID());
  try {
    await store.initialize();
    await store.registerProject(project.id);
    const source = {
      kind: "github" as const,
      issueId: "1",
      number: 1,
      url: "https://github.com/a/b/issues/1",
      revision: "original",
    };
    const work = await store.workItems.create(project.id, source, contract);
    await store.workItems.approve(
      work.id,
      work.revision,
      "scope",
      { approvedBy: "operator", source: "local-operator" },
      project,
    );
    await store.workItems.refreshSource(work.id, {
      ...source,
      revision: "edited",
    });
    assert.equal(
      (await store.workItems.inspect(work.id, project)).decision.state,
      "needs-info",
    );
    await assert.rejects(
      store.workItems.submit(work.id, work.revision, project),
      /revision changed/,
    );
    await assert.rejects(
      store.workItems.propose(work.id, work.revision, contract),
      /revision changed/,
    );
    const fresh = await store.workItems.get(work.id);
    const reassessed = await store.workItems.propose(
      work.id,
      fresh.revision,
      contract,
    );
    assert.equal(
      (await store.workItems.inspect(work.id, project)).decision.state,
      "awaiting-scope-approval",
    );
    assert.notEqual(reassessed.revision, work.revision);
  } finally {
    await store.close();
  }
});

test("stored contract digest uses its redacted canonical representation", {
  skip: !databaseUrl,
}, async () => {
  const store = new Store(databaseUrl!, randomUUID(), (value) =>
    value.replaceAll("secret", "[REDACTED]"),
  );
  try {
    await store.initialize();
    const work = await store.workItems.create(
      project.id,
      { kind: "local", key: "redaction" },
      { ...contract, intent: "secret" },
    );
    assert.equal(work.contract.intent, "[REDACTED]");
    assert.equal(
      work.revision,
      workRevision((await store.workItems.get(work.id)).contract, work.source),
    );
  } finally {
    await store.close();
  }
});

test("a newly approved revision recovers escalation only after stopped processes and a clean checkout", {
  skip: !databaseUrl,
}, async () => {
  const { project, root } = await repository();
  project.sdlc = { ...project.sdlc, enabled: true };
  const artifacts = await mkdtemp(join(tmpdir(), "aw-recovery-proof-"));
  const store = new Store(databaseUrl!, randomUUID());
  try {
    await store.initialize();
    await store.registerProject(project.id);
    const work = await store.workItems.create(
      project.id,
      { kind: "local", key: "recovery" },
      contract,
    );
    await store.workItems.approve(
      work.id,
      work.revision,
      "scope",
      { approvedBy: "operator", source: "local-operator" },
      project,
    );
    const original = await store.workItems.submit(
      work.id,
      work.revision,
      project,
    );
    await store.patchRun(original.id, { outcome: "blocked" });
    await store.blockProject(project.id, "Scope expanded; preserve work");
    const revised = await store.workItems.propose(work.id, work.revision, {
      ...contract,
      acceptanceCriteria: ["Updated expected result"],
    });
    await store.workItems.approve(
      work.id,
      revised.revision,
      "scope",
      { approvedBy: "operator", source: "local-operator" },
      project,
    );
    await assert.rejects(
      store.workItems.submit(work.id, revised.revision, project),
      /blocked/,
    );
    await writeFile(join(root, "unfinished.txt"), "preserve this");
    const submit = () =>
      submitWork({
        store,
        project,
        id: work.id,
        revision: revised.revision,
        recoveryStateDirectory: artifacts,
      });
    await assert.rejects(submit(), /Checkout must be clean/);
    assert.ok((await store.project(project.id)).blocked);
    await rm(join(root, "unfinished.txt"));
    const processDirectory = join(artifacts, original.id);
    await mkdir(processDirectory);
    const processFile = join(processDirectory, "live.process.json");
    const gitJournal = join(root, ".git", "agent-workflows-processes");
    await mkdir(gitJournal, { recursive: true });
    const gitProcessFile = join(gitJournal, "live.process.json");
    const worker = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        detached: process.platform !== "win32",
        stdio: "ignore",
      },
    );
    await once(worker, "spawn");
    const exited = once(worker, "exit");
    try {
      const record = JSON.stringify({ pid: worker.pid });
      await writeFile(processFile, record);
      await assert.rejects(submit(), /still alive/);
      await rm(processFile);
      await writeFile(gitProcessFile, record);
      await assert.rejects(submit(), /still alive/);
    } finally {
      worker.kill("SIGKILL");
      await exited;
    }
    await rm(gitProcessFile);
    await store.setProject(project.id, { paused: true });
    const admitted = await submit();
    assert.notEqual(admitted.id, original.id);
    assert.equal(admitted.work?.revision, revised.revision);
    assert.equal(admitted.attempt, 2);
    assert.deepEqual(await store.project(project.id), {
      id: project.id,
      blocked: null,
      paused: true,
    });
  } finally {
    await store.close();
  }
});
