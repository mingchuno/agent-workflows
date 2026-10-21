import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { projectSchema } from "../packages/core/src/config.js";
import type { ValidationResult } from "../packages/core/src/domain.js";
import { createQueuedWorkRun } from "../packages/core/src/run-record.js";
import { Store } from "../packages/core/src/store.js";
import { admitWork } from "../packages/core/src/work/admission.js";
import { WorkConflictError } from "../packages/core/src/work/errors.js";
import {
  guardWork,
  requiredValidation,
  validationComplete,
} from "../packages/core/src/work/guard.js";
import { issueSource } from "../packages/core/src/work/policy.js";
import {
  type WorkItem,
  workContractSchema,
} from "../packages/core/src/work/schema.js";
import { FixtureHosting } from "./runner-fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const project = projectSchema.parse({
  id: "project",
  checkout: "/tmp",
  hosting: {
    provider: "github",
    origin: "https://example.test",
    repository: "a/b",
    tokenEnv: "TOKEN",
  },
  agent: { provider: "codex" },
  validation: [{ command: "pnpm", args: ["test"] }],
  validationProfiles: { db: [{ command: "pnpm", args: ["test:db"] }] },
  sdlc: { enabled: true },
});
const contract = {
  title: "Add file",
  intent: "Add requested file",
  acceptanceCriteria: ["File exists"],
  scopePaths: ["implemented.txt"],
  verification: { strategy: "Regression test" },
  assessment: { proposedTrack: "B", complexity: "small" },
};
const operator = { approvedBy: "operator", source: "local-operator" } as const;

async function withStore(action: (store: Store) => Promise<void>) {
  const store = new Store(databaseUrl!, randomUUID());
  try {
    await store.initialize();
    await store.registerProject(project.id);
    await action(store);
  } finally {
    await store.close();
  }
}

test(
  "admission waits for scope approval, then admits the observed revision",
  {
    skip: !databaseUrl,
  },
  async () =>
    withStore(async (store) => {
      const hosting = new FixtureHosting();
      const work = await store.workItems.create(
        project.id,
        issueSource("github", hosting.issues[0]!),
        contract,
      );
      const waiting = await admitWork(work.id, project, {
        store,
        hosting: () => hosting,
      });
      assert.equal(waiting.state, "waiting");
      await store.workItems.approve(
        work.id,
        work.revision,
        "scope",
        operator,
        project,
      );
      const admitted = await admitWork(work.id, project, {
        store,
        hosting: () => hosting,
      });
      assert.equal(admitted.state, "admitted");
      assert.equal(
        admitted.state === "admitted" && admitted.run.work?.revision,
        work.revision,
      );
      const replay = await admitWork(work.id, project, {
        store,
        hosting: () => hosting,
      });
      assert.equal(
        replay.state === "admitted" && replay.run.id,
        admitted.state === "admitted" && admitted.run.id,
      );
    }),
);

test(
  "admission observes a closed or edited issue before submitting",
  {
    skip: !databaseUrl,
  },
  async () =>
    withStore(async (store) => {
      const hosting = new FixtureHosting();
      const work = await store.workItems.create(
        project.id,
        issueSource("github", hosting.issues[0]!),
        contract,
      );
      await store.workItems.approve(
        work.id,
        work.revision,
        "scope",
        operator,
        project,
      );
      hosting.issues[0]!.open = false;
      assert.deepEqual(
        await admitWork(work.id, project, { store, hosting: () => hosting }),
        {
          state: "waiting",
          reason: "Issue is closed",
        },
      );
      hosting.issues[0]!.open = true;
      hosting.issues[0]!.body = "Edited after assessment";
      const edited = await admitWork(work.id, project, {
        store,
        hosting: () => hosting,
      });
      assert.equal(edited.state, "waiting");
      assert.notEqual(
        (await store.workItems.get(work.id)).revision,
        work.revision,
      );
    }),
);

test(
  "intake of an existing source observes the source and keeps the contract",
  {
    skip: !databaseUrl,
  },
  async () =>
    withStore(async (store) => {
      const hosting = new FixtureHosting();
      const work = await store.workItems.create(
        project.id,
        issueSource("github", hosting.issues[0]!),
        contract,
      );
      hosting.issues[0]!.body = "Edited after intake";
      const again = await store.workItems.create(
        project.id,
        issueSource("github", hosting.issues[0]!),
        { ...contract, title: "Ignored" },
      );
      assert.equal(again.id, work.id);
      assert.equal(again.contract.title, "Add file");
      assert.notEqual(again.revision, work.revision);
    }),
);

test(
  "an operator-inspected revision that is no longer current is rejected",
  {
    skip: !databaseUrl,
  },
  async () =>
    withStore(async (store) => {
      const hosting = new FixtureHosting();
      const work = await store.workItems.create(
        project.id,
        { kind: "local", key: "task" },
        {
          ...contract,
          assessment: { proposedTrack: "A", complexity: "small" },
        },
      );
      await assert.rejects(
        admitWork(
          work.id,
          { ...project, sdlc: { ...project.sdlc, allowLocalTasks: true } },
          { store, hosting: () => hosting },
          { revision: "a".repeat(64) },
        ),
        WorkConflictError,
      );
    }),
);

test(
  "the guard escalates a Run whose contract changed after admission",
  {
    skip: !databaseUrl,
  },
  async () =>
    withStore(async (store) => {
      const hosting = new FixtureHosting();
      const work = await store.workItems.create(
        project.id,
        issueSource("github", hosting.issues[0]!),
        contract,
      );
      await store.workItems.approve(
        work.id,
        work.revision,
        "scope",
        operator,
        project,
      );
      const admitted = await admitWork(work.id, project, {
        store,
        hosting: () => hosting,
      });
      assert.equal(admitted.state, "admitted");
      const run = admitted.state === "admitted" ? admitted.run : undefined;
      await guardWork(run!, project, { store, hosting });
      await store.workItems.propose(work.id, work.revision, {
        ...contract,
        intent: "Something broader",
      });
      await assert.rejects(
        guardWork(run!, project, { store, hosting }),
        /changed after admission/,
      );
      assert.ok(
        (await store.events(0, run!.id)).some(
          (event) => event.kind === "work-escalated",
        ),
      );
    }),
);

function workRun(profile?: string) {
  const work: WorkItem = {
    id: randomUUID(),
    projectId: project.id,
    source: { kind: "local", key: "task" },
    contract: workContractSchema.parse({
      ...contract,
      verification: { strategy: "Regression test", profile },
    }),
    revision: "a".repeat(64),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return createQueuedWorkRun(work, project);
}
function result(command: string, args: string[], exitCode = 0) {
  return {
    command,
    args,
    exitCode,
    log: "",
    startedAt: "",
    finishedAt: "",
  } satisfies ValidationResult;
}

test("validation is complete only when every required check passed as configured", () => {
  const run = workRun("db");
  assert.deepEqual(
    requiredValidation(run, project).map((check) => check.args),
    [["test"], ["test:db"]],
  );
  assert.equal(validationComplete(run, project), false);
  run.validationStatus = "passed";
  run.validation = [result("pnpm", ["test"]), result("pnpm", ["test:db"])];
  assert.equal(validationComplete(run, project), true);
  run.validation = [result("pnpm", ["test"]), result("pnpm", ["lint"])];
  assert.equal(validationComplete(run, project), false);
  run.validation = [result("pnpm", ["test"]), result("pnpm", ["test:db"], 1)];
  assert.equal(validationComplete(run, project), false);
  assert.throws(
    () => requiredValidation(workRun("missing"), project),
    /Unknown SDLC validation profile/,
  );
});
