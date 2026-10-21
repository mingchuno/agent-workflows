import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configSchema } from "../packages/core/src/config.js";
import type { AgentInvocation } from "../packages/core/src/domain.js";
import { Runner } from "../packages/core/src/runner.js";
import {
  sdlcPolicySchema,
  workContractSchema,
} from "../packages/core/src/work/schema.js";
import { issueSource } from "../packages/core/src/work/store.js";
import { repository } from "./fixtures.js";
import {
  agent,
  FixtureHosting,
  freshPoll,
  waitFor,
} from "./runner-fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
for (const provider of ["codex", "copilot"] as const) {
  for (const track of ["A", "B", "C"] as const) {
    test(`${provider} Track ${track} uses the existing execution engine and enforces gates`, {
      skip: !databaseUrl,
    }, async () => {
      const { project } = await repository();
      project.agent.provider = provider;
      project.hosting.provider = provider === "codex" ? "github" : "gitlab";
      project.sdlc = sdlcPolicySchema.parse({ enabled: true });
      project.validation = [
        {
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
          timeoutMs: 10000,
        },
      ];
      const hosting = new FixtureHosting();
      hosting.issues = [];
      const calls: AgentInvocation[] = [];
      const runner = new Runner({
        config: configSchema.parse({
          id: `sdlc_${randomUUID().replaceAll("-", "")}`,
          stateDirectory: await mkdtemp(join(tmpdir(), "aw-sdlc-")),
          projects: [project],
        }),
        databaseUrl: databaseUrl!,
        hosting: () => hosting,
        agents: {
          [provider]: {
            validate: agent.validate,
            invoke: async (input) => {
              calls.push(input);
              return agent.invoke(input);
            },
          },
        },
      });
      try {
        await runner.start();
        const contract = workContractSchema.parse({
          title: "Add a file",
          intent: "Add the requested file",
          acceptanceCriteria: ["implemented.txt contains implemented"],
          scopePaths: ["implemented.txt"],
          assessment: { proposedTrack: track, complexity: "small" },
          verification: { strategy: "Configured process check" },
          ...(track === "C"
            ? {
                design: {
                  summary: "Add one file",
                  alternatives: ["Keep absent"],
                  stages: ["Add file"],
                  verification: "Inspect file and run check",
                  rollback: "Revert added file",
                },
              }
            : {}),
        });
        const work = await runner.store.workItems.create(
          project.id,
          { kind: "local", key: "add-file" },
          contract,
        );
        if (track !== "A") {
          await freshPoll(runner);
          assert.equal((await runner.store.runs()).length, 0);
          await runner.store.workItems.approve(
            work.id,
            work.revision,
            "scope",
            { approvedBy: "operator", source: "local-operator" },
            project,
          );
        }
        if (track === "C") {
          await freshPoll(runner);
          assert.equal((await runner.store.runs()).length, 0);
          await runner.store.workItems.approve(
            work.id,
            work.revision,
            "design",
            { approvedBy: "operator", source: "local-operator" },
            project,
          );
        }
        await freshPoll(runner);
        await waitFor(async () =>
          (await runner.store.runs()).some(
            (run) => !["queued", "running"].includes(run.outcome),
          ),
        );
        const [run] = await runner.store.runs();
        assert.equal(run?.outcome, "completed", JSON.stringify(run));
        assert.equal(run.work?.track, track);
        assert.equal(run.subject.kind, "local");
        assert.equal(run.readiness?.draft, false);
        assert.deepEqual(run.work?.changedPaths, ["implemented.txt"]);
        assert.equal(hosting.changes.length, 1);
        assert.equal(calls.filter((call) => call.step === "review").length, 1);
        assert.equal(
          calls.find((call) => call.step === "publication")?.resumeSessionId,
          undefined,
        );
        assert.match(calls[0]!.prompt, /Authorized Work Item contract/);
        assert.ok(
          calls.every(
            (call) =>
              call.environment !== undefined &&
              call.environment.TEST_DATABASE_URL === undefined,
          ),
        );
        await freshPoll(runner);
        assert.equal((await runner.store.runs()).length, 1);
      } finally {
        await runner.shutdown();
      }
    });
  }
}

for (const scenario of [
  "protected-path",
  "scope-expansion",
  "issue-edit",
  "missing-validation",
  "manual-checks",
  "repair-expansion",
] as const) {
  test(`SDLC hardening rejects or drafts ${scenario}`, {
    skip: !databaseUrl,
  }, async () => {
    const { project } = await repository();
    project.sdlc = sdlcPolicySchema.parse({
      enabled: true,
      riskRules: [{ paths: ["db/**"], minimumTrack: "C" }],
    });
    const hosting = new FixtureHosting();
    const issue = hosting.issues[0]!;
    if (scenario !== "issue-edit") hosting.issues = [];
    const calls: string[] = [];
    const runner = new Runner({
      config: configSchema.parse({
        id: `sdlc_${randomUUID().replaceAll("-", "")}`,
        stateDirectory: await mkdtemp(join(tmpdir(), "aw-sdlc-")),
        projects: [project],
      }),
      databaseUrl: databaseUrl!,
      hosting: () => hosting,
      agents: {
        codex: {
          validate: agent.validate,
          async invoke(input) {
            calls.push(input.step);
            const output = await agent.invoke(input);
            if (scenario === "repair-expansion" && input.step === "review")
              return JSON.stringify({
                complete: true,
                limitations: [],
                summary: "One fix required",
                findings: [
                  {
                    body: "Correct the implemented result",
                    priority: "P1",
                    path: "implemented.txt",
                    line: 1,
                  },
                ],
              });
            if (scenario === "repair-expansion" && input.step === "fix")
              await writeFile(
                join(input.cwd, "outside-scope.txt"),
                "Unexpected expansion",
              );
            if (input.step === "implementation") {
              if (scenario === "protected-path") {
                const { mkdir } = await import("node:fs/promises");
                await mkdir(join(input.cwd, "db"));
                await writeFile(
                  join(input.cwd, "db/migration.sql"),
                  "select 1;",
                );
              }
              if (scenario === "issue-edit")
                issue.body = "Scope changed while implementing";
            }
            return output;
          },
        },
      },
    });
    try {
      await runner.start();
      const contract = workContractSchema.parse({
        title: "Add file",
        intent: "Add requested file",
        acceptanceCriteria: ["File exists"],
        scopePaths:
          scenario === "scope-expansion"
            ? ["src/**"]
            : scenario === "protected-path"
              ? []
              : ["implemented.txt"],
        assessment: {
          proposedTrack: [
            "missing-validation",
            "manual-checks",
            "repair-expansion",
          ].includes(scenario)
            ? "B"
            : "A",
          complexity: "small",
        },
        verification: {
          strategy: "Configured checks and operator inspection",
          manualChecks:
            scenario === "manual-checks"
              ? ["Operator checks rendered output"]
              : [],
        },
      });
      const work =
        scenario === "issue-edit"
          ? (await runner.store.workItems.list(project.id))[0]!
          : await runner.store.workItems.create(
              project.id,
              { kind: "local", key: scenario },
              contract,
            );
      if (scenario === "issue-edit")
        await runner.store.workItems.propose(work.id, work.revision, contract);
      if (
        ["missing-validation", "manual-checks", "repair-expansion"].includes(
          scenario,
        )
      )
        await runner.store.workItems.approve(
          work.id,
          work.revision,
          "scope",
          { approvedBy: "operator", source: "local-operator" },
          project,
        );
      await freshPoll(runner);
      await waitFor(async () =>
        (await runner.store.runs()).some(
          (run) => !["queued", "running"].includes(run.outcome),
        ),
      );
      const [run] = await runner.store.runs();
      if (["missing-validation", "manual-checks"].includes(scenario)) {
        assert.equal(run?.outcome, "completed", JSON.stringify(run));
        assert.equal(run.readiness?.draft, true);
        assert.match(
          run.readiness.reasons.join(" "),
          /validation is incomplete/,
        );
        assert.equal(calls.filter((step) => step === "fix").length, 0);
      } else {
        assert.equal(run?.outcome, "blocked", JSON.stringify(run));
        assert.equal(calls.includes("publication"), false);
        assert.equal(hosting.changes.length, 0);
      }
    } finally {
      await runner.shutdown();
    }
  });
}

test("closed enterprise history does not starve later ready work", {
  skip: !databaseUrl,
}, async () => {
  const { project } = await repository();
  project.sdlc = sdlcPolicySchema.parse({
    enabled: true,
    approvalSource: "github",
    approvers: ["human"],
    allowLocalTasks: false,
  });
  const hosting = new FixtureHosting();
  hosting.listApprovalComments = async () => [];
  const runner = new Runner({
    config: configSchema.parse({
      id: `sdlc_${randomUUID().replaceAll("-", "")}`,
      stateDirectory: await mkdtemp(join(tmpdir(), "aw-sdlc-")),
      projects: [project],
    }),
    databaseUrl: databaseUrl!,
    hosting: () => hosting,
    agents: { codex: agent },
  });
  try {
    await runner.start();
    hosting.issues[0]!.open = false;
    const next = {
      ...hosting.issues[0]!,
      id: "2",
      number: 2,
      url: "https://fixture.invalid/2",
      open: true,
    };
    hosting.issues.push(next);
    const contract = {
      title: next.title,
      intent: next.body,
      acceptanceCriteria: ["Requested file exists"],
      scopePaths: ["implemented.txt"],
      assessment: { proposedTrack: "A", complexity: "small" },
    };
    // A background poll may already have taken in the labelled issue with a
    // bare contract; propose the assessed contract onto whichever record exists.
    const intake = await runner.store.workItems.create(
      project.id,
      issueSource("github", next),
      contract,
    );
    const work = await runner.store.workItems.propose(
      intake.id,
      intake.revision,
      contract,
    );
    await freshPoll(runner);
    await waitFor(async () =>
      (await runner.store.runs()).some((run) => run.outcome === "completed"),
    );
    const runs = await runner.store.runs();
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.work?.workItemId, work.id);
    await freshPoll(runner);
    assert.equal((await runner.store.runs()).length, 1);
  } finally {
    await runner.shutdown();
  }
});

test("one failing Work Item does not stop the project poll", {
  skip: !databaseUrl,
}, async () => {
  const { project } = await repository();
  project.sdlc = sdlcPolicySchema.parse({ enabled: true });
  const hosting = new FixtureHosting();
  const deleted = { ...hosting.issues[0]!, id: "9", number: 9 };
  hosting.issues = [];
  hosting.getIssue = async (number) => {
    throw new Error(`Issue ${number} not found`);
  };
  const runner = new Runner({
    config: configSchema.parse({
      id: `sdlc_${randomUUID().replaceAll("-", "")}`,
      stateDirectory: await mkdtemp(join(tmpdir(), "aw-sdlc-")),
      projects: [project],
    }),
    databaseUrl: databaseUrl!,
    hosting: () => hosting,
    agents: { codex: agent },
  });
  try {
    await runner.start();
    const fastTrack = {
      acceptanceCriteria: ["Requested file exists"],
      assessment: { proposedTrack: "A", complexity: "small" },
    };
    const broken = await runner.store.workItems.create(
      project.id,
      issueSource("github", deleted),
      { title: deleted.title, intent: deleted.body, ...fastTrack },
    );
    const local = await runner.store.workItems.create(
      project.id,
      { kind: "local", key: "still-admitted" },
      { title: "Add a file", intent: "Add the requested file", ...fastTrack },
    );
    await freshPoll(runner);
    const runs = await runner.store.runs();
    assert.deepEqual(
      runs.map((run) => run.work?.workItemId),
      [local.id],
    );
    const failures = (await runner.store.events()).filter(
      (event) => event.kind === "work-poll-error",
    );
    assert.ok(failures.length > 0);
    assert.ok(
      failures.every(
        (event) =>
          (event.payload as { workItemId: string }).workItemId === broken.id,
      ),
    );
  } finally {
    await runner.shutdown();
  }
});

test("admitted Work Items cost no hosting calls on later polls", {
  skip: !databaseUrl,
}, async () => {
  const { project } = await repository();
  project.sdlc = sdlcPolicySchema.parse({
    enabled: true,
    approvalSource: "github",
    approvers: ["human"],
  });
  const hosting = new FixtureHosting();
  const issue = hosting.issues[0]!;
  hosting.issues = [];
  let hostingCalls = 0;
  const getIssue = hosting.getIssue.bind(hosting);
  hosting.getIssue = async (number) => {
    hostingCalls++;
    return number === issue.number ? issue : getIssue(number);
  };
  hosting.listApprovalComments = async () => {
    hostingCalls++;
    return [];
  };
  const runner = new Runner({
    config: configSchema.parse({
      id: `sdlc_${randomUUID().replaceAll("-", "")}`,
      stateDirectory: await mkdtemp(join(tmpdir(), "aw-sdlc-")),
      projects: [project],
    }),
    databaseUrl: databaseUrl!,
    hosting: () => hosting,
    agents: { codex: agent },
  });
  try {
    await runner.start();
    await runner.store.workItems.create(
      project.id,
      issueSource("github", issue),
      {
        title: issue.title,
        intent: issue.body,
        acceptanceCriteria: ["Requested file exists"],
        scopePaths: ["implemented.txt"],
        assessment: { proposedTrack: "A", complexity: "small" },
      },
    );
    await freshPoll(runner);
    await waitFor(async () =>
      (await runner.store.runs()).some((run) => run.outcome === "completed"),
    );
    const before = hostingCalls;
    await freshPoll(runner);
    await freshPoll(runner);
    assert.equal(hostingCalls, before);
    assert.equal((await runner.store.runs()).length, 1);
  } finally {
    await runner.shutdown();
  }
});
