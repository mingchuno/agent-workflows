import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configSchema } from "../src/config.js";
import type { AgentInvocation } from "../src/domain.js";
import { Runner } from "../src/runner.js";
import { command } from "../src/runtime/process.js";
import { repository } from "./fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

import { agent, FixtureHosting, waitFor } from "./runner-fixtures.js";

test("public runner completes durable issue-to-review workflow and deduplicates polling", {
  skip: !databaseUrl,
}, async () => {
  const { project } = await repository();
  const hosting = new FixtureHosting();
  const config = configSchema.parse({
    id: "test_" + randomUUID().replaceAll("-", ""),
    stateDirectory: await mkdtemp(join(tmpdir(), "aw-artifacts-")),
    projects: [project],
  });
  const calls: AgentInvocation[] = [];
  const runner = new Runner({
    config,
    databaseUrl: databaseUrl!,
    hosting: () => hosting,
    agents: {
      codex: {
        validate: agent.validate,
        async invoke(input) {
          calls.push(input);
          if (input.step === "publication") {
            assert.match(input.prompt, /Changed paths:.*implemented.txt/);
            assert.match(
              (
                await command(
                  "git",
                  ["ls-files", "--others", "--exclude-standard"],
                  { cwd: input.cwd },
                )
              ).stdout,
              /implemented.txt/,
            );
            assert.equal(
              await readFile(join(input.cwd, "implemented.txt"), "utf8"),
              "implemented\n",
            );
          }
          if (input.step === "review") {
            const base = /Base revision: ([0-9a-f]+)/.exec(input.prompt)![1]!;
            const head = /Published revision: ([0-9a-f]+)/.exec(
              input.prompt,
            )![1]!;
            const diff = await command(
              "git",
              ["diff", base, head, "--", "implemented.txt"],
              { cwd: input.cwd },
            );
            assert.match(diff.stdout, /\+implemented/);
          }
          return agent.invoke(input);
        },
      },
    },
  });
  try {
    await runner.start();
    await waitFor(async () => {
      const runs = await runner.store.runs();
      return (
        !!runs.length &&
        runs.every((r) => !["running", "queued"].includes(r.outcome))
      );
    });
    const runs = await runner.store.runs();
    assert.equal(runs[0]?.outcome, "completed", JSON.stringify(runs));
    assert.equal(hosting.changes.length, 1);
    assert.equal(hosting.reviews.length, 1);
    const sessions = await runner.store.invocations(runs[0]!.id);
    assert.equal(sessions.length, 3);
    const implementation = sessions.find((s) => s.step === "implementation")!;
    const publication = sessions.find((s) => s.step === "publication")!;
    const review = sessions.find((s) => s.step === "review")!;
    assert.equal(publication.sessionId, implementation.sessionId);
    assert.equal(publication.resumedFrom, implementation.sessionId);
    assert.notEqual(review.sessionId, implementation.sessionId);
    assert.equal(review.resumedFrom, undefined);
    assert.equal(calls[1]!.resumeSessionId, implementation.sessionId);
    assert.equal(calls[2]!.resumeSessionId, undefined);
    assert.equal("diff" in runs[0]!.snapshot!, false);
    const artifacts = await readdir(join(config.stateDirectory, runs[0]!.id), {
      recursive: true,
    });
    assert.equal(
      artifacts.some((path) =>
        /publication-input|review-input|index\.json|patch-/.test(path),
      ),
      false,
    );
    await runner.poll();
    assert.equal((await runner.store.runs()).length, 1);
    const configPath = join(config.stateDirectory, "config.json");
    await writeFile(configPath, JSON.stringify(config));
    const status = await command(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "--config",
        configPath,
        "status",
        "--json",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, AGENT_WORKFLOWS_DATABASE_URL: databaseUrl! },
      },
    );
    assert.equal(JSON.parse(status.stdout).runs[0].id, runs[0]!.id);
  } finally {
    await runner.shutdown();
  }
});

for (const scenario of [
  "fresh",
  "missing-session",
  "fresh-without-session",
  "review-mutation",
  "large-change",
] as const) {
  test(`publication session policy and checkout preservation: ${scenario}`, {
    skip: !databaseUrl,
  }, async () => {
    const { project } = await repository();
    const useNewSession =
      scenario === "fresh" || scenario === "fresh-without-session";
    project.stages.publication.useNewSession = useNewSession;
    if (useNewSession)
      project.stages.publication.profile = { provider: "copilot" };
    const calls: AgentInvocation[] = [];
    const controlled = {
      validate: agent.validate,
      async invoke(input: AgentInvocation) {
        calls.push(input);
        if (input.step === "implementation" && scenario === "large-change")
          await writeFile(
            join(input.cwd, "large.txt"),
            Buffer.alloc(33 * 1024 * 1024, 120),
          );
        if (input.step === "implementation" && scenario.includes("session"))
          return agent.invoke({ ...input, session: async () => {} });
        if (input.step === "review" && scenario === "review-mutation")
          await writeFile(
            join(input.cwd, "unexpected.txt"),
            "review changed source",
          );
        return agent.invoke(input);
      },
    };
    const hosting = new FixtureHosting();
    const runner = new Runner({
      config: configSchema.parse({
        id: "session_" + randomUUID().replaceAll("-", ""),
        stateDirectory: await mkdtemp(join(tmpdir(), "aw-sessions-")),
        projects: [project],
      }),
      databaseUrl: databaseUrl!,
      hosting: () => hosting,
      agents: { codex: controlled, copilot: controlled },
    });
    try {
      await runner.start();
      await waitFor(async () =>
        (await runner.store.runs()).some(
          (run) => !["queued", "running"].includes(run.outcome),
        ),
      );
      const run = (await runner.store.runs())[0]!;
      if (scenario === "large-change") {
        assert.equal(
          run.outcome,
          "completed",
          run.error ?? "unexpected outcome",
        );
        assert.equal(hosting.reviews.length, 1);
        assert.equal("diff" in run.snapshot!, false);
      } else if (useNewSession) {
        assert.equal(
          run.outcome,
          "completed",
          run.error ?? "unexpected outcome",
        );
        const publication = calls.find((call) => call.step === "publication")!;
        assert.equal(publication.resumeSessionId, undefined);
        assert.equal(publication.profile.provider, "copilot");
        const records = await runner.store.invocations(run.id);
        assert.equal(
          new Set(records.map((record) => record.sessionId)).size,
          3,
        );
      } else {
        assert.equal(run.outcome, "blocked", run.error ?? "unexpected outcome");
        assert.equal(hosting.reviews.length, 0);
        if (scenario === "missing-session") {
          assert.match(
            run.error!,
            /Implementation session unavailable.*useNewSession/,
          );
          assert.equal(calls.length, 1);
          assert.equal(hosting.changes.length, 0);
          assert.equal(run.head, undefined);
          assert.equal(run.phase, "publication-session");
        } else {
          assert.match(run.error!, /Unexpected checkout mutation/);
          assert.equal(calls.length, 3);
          assert.equal(run.review, undefined);
          assert.equal(run.phase, "review");
        }
      }
    } finally {
      await runner.shutdown();
    }
  });
}

test("ticket profile runs after baseline checks and is recorded on the run", {
  skip: !databaseUrl,
}, async () => {
  const { project } = await repository();
  const hosting = new FixtureHosting();
  hosting.issues[0]!.body +=
    "\n\n```agent-workflows-validation\nmigration\n```";
  project.validation = [
    {
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      timeoutMs: 30_000,
    },
  ];
  project.validationProfiles.migration = [
    {
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      timeoutMs: 30_000,
    },
  ];
  const runner = new Runner({
    config: configSchema.parse({
      id: "validation_" + randomUUID().replaceAll("-", ""),
      stateDirectory: await mkdtemp(join(tmpdir(), "aw-validation-")),
      projects: [project],
    }),
    databaseUrl: databaseUrl!,
    hosting: () => hosting,
    agents: { codex: agent },
  });
  try {
    await runner.start();
    await waitFor(async () =>
      (await runner.store.runs()).some((run) => run.outcome === "completed"),
    );
    const run = (await runner.store.runs())[0]!;
    assert.equal(run.validationProfile, "migration");
    assert.equal(run.validation?.length, 2);
    assert.deepEqual(
      run.validation?.map((check) => check.exitCode),
      [0, 0],
    );
  } finally {
    await runner.shutdown();
  }
});

test("unknown ticket profile fails before implementation", {
  skip: !databaseUrl,
}, async () => {
  const { project } = await repository();
  const hosting = new FixtureHosting();
  hosting.issues[0]!.body += "\n\n```agent-workflows-validation\nunknown\n```";
  let invocations = 0;
  const runner = new Runner({
    config: configSchema.parse({
      id: "invalid_validation_" + randomUUID().replaceAll("-", ""),
      stateDirectory: await mkdtemp(join(tmpdir(), "aw-invalid-validation-")),
      projects: [project],
    }),
    databaseUrl: databaseUrl!,
    hosting: () => hosting,
    agents: {
      codex: {
        ...agent,
        async invoke() {
          invocations++;
          return "";
        },
      },
    },
  });
  try {
    await runner.start();
    await waitFor(async () =>
      (await runner.store.runs()).some((run) => run.outcome === "failed"),
    );
    assert.equal(invocations, 0);
    assert.match(
      (await runner.store.runs())[0]!.error!,
      /Unknown validation profile/,
    );
  } finally {
    await runner.shutdown();
  }
});

test("configured stage timeout reaches the agent adapter", {
  skip: !databaseUrl,
}, async () => {
  const { project } = await repository();
  project.stages.implementation.timeoutMs = 3_600_000;
  const observed: Array<number | undefined> = [];
  const runner = new Runner({
    config: configSchema.parse({
      id: "timeout_" + randomUUID().replaceAll("-", ""),
      stateDirectory: await mkdtemp(join(tmpdir(), "aw-timeout-")),
      projects: [project],
    }),
    databaseUrl: databaseUrl!,
    hosting: () => new FixtureHosting(),
    agents: {
      codex: {
        validate: agent.validate,
        async invoke(input) {
          observed.push(input.timeoutMs);
          return "No changes needed";
        },
      },
    },
  });
  try {
    await runner.start();
    await waitFor(async () =>
      (await runner.store.runs()).some((run) => run.outcome === "no-change"),
    );
    assert.equal(observed.length, 1);
    assert.ok(observed[0]! > 3_590_000 && observed[0]! <= 3_600_000);
  } finally {
    await runner.shutdown();
  }
});
