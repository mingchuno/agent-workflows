import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { configSchema, type Project } from "../src/config.js";
import type { AgentAdapter } from "../src/domain.js";
import { defaultWorkflow } from "../src/operations.js";
import { Runner } from "../src/runner.js";
import { repository } from "./fixtures.js";
import { agent, FixtureHosting, waitFor } from "./runner-fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
async function setup(
  projects: Project[],
  adapters: Record<string, AgentAdapter> = { codex: agent, copilot: agent },
) {
  const hosts = new Map(
    projects.map((project) => [project.id, new FixtureHosting()]),
  );
  for (const [id, host] of hosts)
    host.identity = `https://fixture.invalid/${id}`;
  const config = configSchema.parse({
    id: "test_" + randomUUID().replaceAll("-", ""),
    stateDirectory: await mkdtemp(join(tmpdir(), "aw-artifacts-")),
    projects,
  });
  const runner = new Runner({
    config,
    databaseUrl: databaseUrl!,
    hosting: (project) => hosts.get(project.id)!,
    agents: adapters,
  });
  return { runner, hosts, config };
}
const terminal = async (runner: Runner, count: number) => {
  const runs = await runner.store.runs();
  return (
    runs.length === count &&
    runs.every((run) => !["queued", "running"].includes(run.outcome))
  );
};
test("all four provider combinations run concurrently, each project remains sequential", {
  skip: !databaseUrl,
}, async () => {
  const projects: Project[] = [];
  for (const provider of ["codex", "copilot"] as const)
    for (const host of ["github", "gitlab"] as const) {
      const { project } = await repository();
      project.id = `${provider}_${host}`;
      project.agent = { provider, model: "implementation" };
      project.stages.publication.profile = { provider, model: "writer" };
      project.stages.review.profile = {
        provider: provider === "codex" ? "copilot" : "codex",
        model: "reviewer",
      };
      project.hosting.provider = host;
      projects.push(project);
    }
  const active = new Map<string, number>();
  let peak = 0;
  const observed: Array<{ step: string; model?: string; provider: string }> =
    [];
  const controlled: AgentAdapter = {
    validate: agent.validate,
    async invoke(input) {
      observed.push({
        step: input.step,
        model: input.profile.model,
        provider: input.profile.provider,
      });
      if (input.step === "implementation") {
        active.set(input.cwd, (active.get(input.cwd) ?? 0) + 1);
        assert.equal(active.get(input.cwd), 1);
        peak = Math.max(peak, active.size);
        await new Promise((resolve) => setTimeout(resolve, 300));
        try {
          return await agent.invoke(input);
        } finally {
          active.delete(input.cwd);
        }
      }
      return agent.invoke(input);
    },
  };
  const { runner, hosts } = await setup(projects, {
    codex: controlled,
    copilot: controlled,
  });
  for (const host of hosts.values())
    host.issues.push({ ...host.issues[0]!, id: "2", number: 2 });
  try {
    await runner.start();
    await waitFor(() => terminal(runner, 8));
    assert.ok(peak > 1);
    for (const run of await runner.store.runs())
      assert.equal(run.outcome, "completed", JSON.stringify(run));
    for (const host of hosts.values()) assert.equal(host.changes.length, 2);
    assert.ok(
      observed.some(
        (value) => value.step === "publication" && value.model === "writer",
      ),
    );
    assert.ok(
      observed.some(
        (value) => value.step === "review" && value.provider === "copilot",
      ),
    );
  } finally {
    await runner.shutdown();
  }
});
test("validation failure, malformed publication and no-change stop publication; other projects finish", {
  skip: !databaseUrl,
}, async () => {
  const projects: Project[] = [];
  for (const id of ["validation", "malformed", "nochange", "healthy"]) {
    const { project } = await repository();
    project.id = id;
    projects.push(project);
  }
  projects[0]!.validation = [
    {
      command: process.execPath,
      args: ["-e", "process.exit(3)"],
      timeoutMs: 1000,
    },
  ];
  const controlled: AgentAdapter = {
    validate: agent.validate,
    async invoke(input) {
      const project = projects.find(
        (project) =>
          project.checkout === input.cwd ||
          input.cwd.endsWith(project.checkout.split("/").at(-1)!),
      )!;
      if (project.id === "nochange" && input.step === "implementation") {
        await input.session("no-change-session");
        return "nothing to do";
      }
      if (project.id === "malformed" && input.step === "publication")
        return '{"title":"incomplete"}';
      return agent.invoke(input);
    },
  };
  const { runner, hosts } = await setup(projects, { codex: controlled });
  try {
    await runner.start();
    await waitFor(() => terminal(runner, 4));
    const runs = await runner.store.runs();
    assert.equal(
      runs.find((run) => run.projectId === "healthy")!.outcome,
      "completed",
    );
    assert.equal(
      runs.find((run) => run.projectId === "nochange")!.outcome,
      "no-change",
    );
    for (const id of ["validation", "malformed"]) {
      assert.equal(runs.find((run) => run.projectId === id)!.outcome, "failed");
      assert.ok((await runner.store.project(id)).blocked);
      assert.equal(hosts.get(id)!.changes.length, 0);
      assert.equal(
        await readFile(
          join(projects.find((p) => p.id === id)!.checkout, "implemented.txt"),
          "utf8",
        ),
        "implemented\n",
      );
    }
  } finally {
    await runner.shutdown();
  }
});
test("paused intake holds pending work and retry requires a clean checkout", {
  skip: !databaseUrl,
}, async () => {
  const { project } = await repository();
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => (finish = resolve));
  let started = false;
  const controlled: AgentAdapter = {
    validate: agent.validate,
    async invoke(input) {
      if (input.step === "implementation") {
        started = true;
        await gate;
      }
      return agent.invoke(input);
    },
  };
  const { runner, hosts } = await setup([project], { codex: controlled });
  hosts.get(project.id)!.issues.push({
    ...hosts.get(project.id)!.issues[0]!,
    id: "2",
    number: 2,
  });
  try {
    await runner.start();
    await waitFor(async () => started);
    await runner.pause(project.id);
    finish();
    await waitFor(async () =>
      (await runner.store.runs()).some((run) => run.outcome === "completed"),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      (await runner.store.runs()).filter((run) => run.outcome === "queued")
        .length,
      1,
    );
    await runner.resume(project.id);
    await waitFor(() => terminal(runner, 2));
    const run = (await runner.store.runs())[0]!;
    await assert.rejects(runner.retry(run.id), /Only failed/);
  } finally {
    finish();
    await runner.shutdown();
  }
});
test("custom durable operations preserve session history and stale reviews are blocked", {
  skip: !databaseUrl,
}, async () => {
  const { project } = await repository();
  const { runner, hosts } = await setup([project]);
  const host = hosts.get(project.id)!;
  host.head = async () => "changed-head";
  runner.options.workflow = async (operations) => {
    await defaultWorkflow(operations);
  };
  try {
    await runner.start();
    await waitFor(() => terminal(runner, 1));
    const run = (await runner.store.runs())[0]!;
    assert.equal(run.outcome, "blocked");
    assert.match(run.error!, /stale/);
    assert.equal(host.reviews.length, 0);
    assert.equal((await runner.store.invocations(run.id)).length, 3);
  } finally {
    await runner.shutdown();
  }
});
test("duplicate checkout registration is rejected before execution", {
  skip: !databaseUrl,
}, async () => {
  const { project } = await repository();
  const { runner } = await setup([project, { ...project, id: "second" }]);
  try {
    await assert.rejects(runner.start(), /Duplicate/);
  } finally {
    await runner.shutdown();
  }
});

test("custom agent steps keep multiple invocations and query events survive restart", {
  skip: !databaseUrl,
}, async () => {
  const { project } = await repository();
  const { runner, config } = await setup([project]);
  let events = 0;
  runner.options.workflow = async (operations) => {
    await operations.prepare();
    await operations.invoke("custom-report", project.stages.publication, {
      defaultPrompt: "Return a report",
      readOnly: true,
    });
    await operations.invoke("custom-report", project.stages.publication, {
      defaultPrompt: "Return a second report",
      readOnly: true,
    });
    await operations.complete("no-change");
  };
  let runId = "";
  try {
    await runner.start();
    const unsubscribe = runner.store.subscribe(() => events++, {
      intervalMs: 20,
    });
    await waitFor(() => terminal(runner, 1));
    await waitFor(async () => events > 0);
    unsubscribe();
    const run = (await runner.store.runs())[0]!;
    runId = run.id;
    const sessions = await runner.store.invocations(run.id);
    assert.equal(sessions.length, 2);
    assert.notEqual(sessions[0]?.stepId, sessions[1]?.stepId);
  } finally {
    await runner.shutdown();
  }
  const { Store } = await import("../src/store.js");
  const reader = new Store(databaseUrl!, config.id);
  try {
    assert.equal((await reader.invocations(runId)).length, 2);
    assert.ok((await reader.events()).length > 0);
  } finally {
    await reader.close();
  }
});
test("custom writable stages attribute retained providers in first-contribution order", {
  skip: !databaseUrl,
}, async () => {
  const { project, git } = await repository();
  const controlled: AgentAdapter = {
    validate: agent.validate,
    async invoke(input) {
      if (input.step === "copilot-change") {
        await writeFile(join(input.cwd, "shared.txt"), "copilot\n");
        return "copilot change";
      }
      if (input.step === "codex-change") {
        await writeFile(join(input.cwd, "shared.txt"), "copilot\ncodex\n");
        return "codex change";
      }
      if (input.step === "copilot-mode") {
        await chmod(join(input.cwd, "shared.txt"), 0o755);
        return "copilot mode change";
      }
      if (input.step === "copilot-no-change") return "no change";
      return agent.invoke(input);
    },
  };
  const { runner } = await setup([project], {
    codex: controlled,
    copilot: controlled,
  });
  runner.options.workflow = async (operations) => {
    await operations.prepare();
    await operations.invoke(
      "copilot-change",
      { ...project.stages.implementation, profile: { provider: "copilot" } },
      { defaultPrompt: "Make the Copilot change" },
    );
    await operations.invoke(
      "codex-change",
      { ...project.stages.implementation, profile: { provider: "codex" } },
      { defaultPrompt: "Make the Codex change" },
    );
    await operations.invoke(
      "copilot-mode",
      { ...project.stages.implementation, profile: { provider: "copilot" } },
      { defaultPrompt: "Make the Copilot mode change" },
    );
    await operations.invoke(
      "copilot-no-change",
      { ...project.stages.implementation, profile: { provider: "copilot" } },
      { defaultPrompt: "Make no change" },
    );
    assert.equal(await operations.validate(), true);
    await operations.writePublication();
    await operations.commit();
    await operations.complete();
  };
  try {
    await runner.start();
    await waitFor(() => terminal(runner, 1));
    const run = (await runner.store.runs())[0]!;
    assert.equal(run.outcome, "completed", run.error ?? "unexpected outcome");
    assert.equal(run.contributionCandidates?.length, 3);
    assert.deepEqual(run.contributingProviders, ["copilot", "codex"]);
    const message = (await git("log", "-1", "--format=%B")).stdout;
    assert.ok(
      message.indexOf("Co-authored-by: Copilot") <
        message.indexOf("Co-authored-by: Codex"),
    );
    assert.equal(message.match(/Co-authored-by: Copilot/g)?.length, 1);
    assert.equal(message.match(/Co-authored-by: Codex/g)?.length, 1);
    assert.equal(message.match(/Agent-Workflows-Run:/g)?.length, 1);
    assert.equal(
      (await git("log", "-1", "--format=%an|%ae|%cn|%ce")).stdout.trim(),
      "Fixture|fixture@example.com|Fixture|fixture@example.com",
    );
  } finally {
    await runner.shutdown();
  }
});

test("caught failed writable stages do not receive contribution credit", {
  skip: !databaseUrl,
}, async () => {
  const { project, git } = await repository();
  const controlled: AgentAdapter = {
    validate: agent.validate,
    async invoke(input) {
      if (input.step !== "failing-change") return agent.invoke(input);
      if (!input.readOnly)
        await writeFile(join(input.cwd, "failed.txt"), "retained change\n");
      return "invalid output";
    },
  };
  const { runner } = await setup([project], { codex: controlled });
  runner.options.workflow = async (operations) => {
    await operations.prepare();
    await assert.rejects(
      operations.invoke("failing-change", project.stages.implementation, {
        defaultPrompt: "Make a change but return invalid output",
        outputContract: z.strictObject({ result: z.string() }),
      }),
      /Invalid output/,
    );
    assert.equal(await operations.validate(), true);
    await operations.writePublication();
    await operations.commit();
    await operations.complete();
  };
  try {
    await runner.start();
    await waitFor(() => terminal(runner, 1));
    const run = (await runner.store.runs())[0]!;
    assert.equal(run.outcome, "completed", run.error ?? "unexpected outcome");
    assert.deepEqual(run.contributionCandidates, undefined);
    assert.deepEqual(run.contributingProviders, []);
    assert.doesNotMatch(
      (await git("log", "-1", "--format=%B")).stdout,
      /Co-authored-by:/,
    );
  } finally {
    await runner.shutdown();
  }
});

test("missing native Git identity fails at commit without publication effects", {
  skip: !databaseUrl,
}, async () => {
  const { project, git } = await repository();
  await git("config", "--unset", "user.name");
  await git("config", "--unset", "user.email");
  const { runner, hosts } = await setup([project]);
  const names = [
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
    "EMAIL",
  ] as const;
  const prior = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  for (const name of names) process.env[name] = "";
  try {
    await runner.start();
    await waitFor(() => terminal(runner, 1));
    const run = (await runner.store.runs())[0]!;
    assert.equal(run.outcome, "failed");
    assert.equal(run.phase, "commit");
    assert.match(run.error!, /Author identity unknown|empty ident name/);
    assert.equal(hosts.get(project.id)!.changes.length, 0);
  } finally {
    for (const name of names) {
      const value = prior[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await runner.shutdown();
  }
});
test("eligibility is rechecked and removed labels prevent agent execution", {
  skip: !databaseUrl,
}, async () => {
  const { project } = await repository();
  const { runner, hosts } = await setup([project]);
  const host = hosts.get(project.id)!;
  host.getIssue = async () => ({ ...host.issues[0]!, labels: [] });
  try {
    await runner.start();
    await waitFor(() => terminal(runner, 1));
    const run = (await runner.store.runs())[0]!;
    assert.equal(run.outcome, "ineligible");
    assert.equal((await runner.store.invocations(run.id)).length, 0);
  } finally {
    await runner.shutdown();
  }
});
test("failed work cannot retry until files are preserved and checkout made clean", {
  skip: !databaseUrl,
}, async () => {
  const { project, git, root } = await repository();
  let shouldFail = true;
  const controlled: AgentAdapter = {
    validate: agent.validate,
    async invoke(input) {
      const output = await agent.invoke(input);
      if (shouldFail && input.step === "implementation")
        throw new Error("controlled agent failure");
      return output;
    },
  };
  const { runner } = await setup([project], { codex: controlled });
  try {
    await runner.start();
    await waitFor(() => terminal(runner, 1));
    const original = (await runner.store.runs())[0]!;
    await assert.rejects(runner.retry(original.id), /clean/);
    await git("add", ".");
    await git("commit", "-m", "preserve unfinished fixture");
    shouldFail = false;
    const retry = await runner.retry(original.id);
    await waitFor(() => terminal(runner, 2));
    assert.equal((await runner.store.run(retry)).retryOf, original.id);
    assert.equal((await runner.store.run(retry)).outcome, "completed");
    assert.equal(
      await readFile(join(root, "implemented.txt"), "utf8"),
      "implemented\n",
    );
  } finally {
    await runner.shutdown();
  }
});

test("stop waits for controlled child termination and prevents checkout reuse", {
  skip: !databaseUrl,
}, async () => {
  const { project } = await repository();
  const { command } = await import("../src/runtime/process.js");
  const { processExists } = await import("../src/runtime/ownership.js");
  let childPid = 0;
  const controlled: AgentAdapter = {
    validate: agent.validate,
    async invoke(input) {
      await input.session("controlled-process");
      await command(
        process.execPath,
        [
          "-e",
          `
            process.on("SIGTERM", () => {});
            require("node:fs").writeFileSync(process.argv[1], String(process.pid));
            console.log(process.pid);
            console.error("controlled startup diagnostic");
            setInterval(() => {}, 100);
          `,
          readyFile,
        ],
        {
          cwd: input.cwd,
          signal: input.signal,
          processFile: input.processFile,
          killGraceMs: 100,
        },
      );
      return "";
    },
  };
  const { runner, hosts, config } = await setup([project], {
    codex: controlled,
  });
  const readyFile = join(config.stateDirectory, "controlled-child.ready");
  hosts.get(project.id)!.issues.push({
    ...hosts.get(project.id)!.issues[0]!,
    id: "2",
    number: 2,
  });
  try {
    await runner.start();
    try {
      await waitFor(async () => {
        try {
          childPid = Number(await readFile(readyFile, "utf8"));
          return Number.isSafeInteger(childPid) && childPid > 0;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      });
    } catch (error) {
      const runs = (await runner.store.runs()).map(
        ({ id, outcome, error }) => ({
          id,
          outcome,
          error,
        }),
      );
      throw new Error(
        `Controlled child did not become ready: ${JSON.stringify(runs)}`,
        {
          cause: error,
        },
      );
    }
    await runner.pause(project.id);
    const run = (await runner.store.runs())[0]!;
    await runner.stop(run.id);
    assert.equal(processExists(childPid), false);
    assert.equal((await runner.store.run(run.id)).outcome, "cancelled");
    assert.equal((await runner.store.runs())[1]?.outcome, "queued");
  } finally {
    await runner.shutdown();
  }
});
test("secrets are redacted from persisted invocation events and artifacts", {
  skip: !databaseUrl,
}, async () => {
  const { project } = await repository();
  process.env.FIXTURE_SECRET_TOKEN = "fixture-secret-value";
  const controlled: AgentAdapter = {
    validate: agent.validate,
    async invoke(input) {
      await input.event({ text: "fixture-secret-value" });
      throw new Error("fixture-secret-value");
    },
  };
  const { runner } = await setup([project], { codex: controlled });
  try {
    await runner.start();
    await waitFor(() => terminal(runner, 1));
    const run = (await runner.store.runs())[0]!;
    const invocations = await runner.store.invocations(run.id);
    assert.equal(invocations[0]?.sessionState, "unavailable");
    assert.ok(
      !JSON.stringify(await runner.store.events()).includes(
        "fixture-secret-value",
      ),
    );
    assert.ok(!JSON.stringify(run).includes("fixture-secret-value"));
    assert.equal(
      (await readFile(invocations[0]!.log, "utf8")).includes(
        "fixture-secret-value",
      ),
      false,
    );
  } finally {
    await runner.shutdown();
    delete process.env.FIXTURE_SECRET_TOKEN;
  }
});

test("documented custom workflow executes through the public runner", {
  skip: !databaseUrl,
}, async () => {
  const { reportingWorkflow } = await import("../examples/custom-workflow.js");
  const { project } = await repository();
  const { runner } = await setup([project]);
  runner.options.workflow = reportingWorkflow;
  runner.options.workflowVersion = "reporting-v1";
  try {
    await runner.start();
    await waitFor(() => terminal(runner, 1));
    const run = (await runner.store.runs())[0]!;
    assert.equal(run.outcome, "completed");
    assert.ok(
      (await runner.store.events(0, run.id)).some(
        (event) => event.kind === "validation-report",
      ),
    );
  } finally {
    await runner.shutdown();
  }
});
test("validation timeout records failure evidence and preserves unfinished work", {
  skip: !databaseUrl,
}, async () => {
  const { project } = await repository();
  project.validation = [
    {
      command: process.execPath,
      args: ["-e", 'process.on("SIGTERM",()=>{}); setInterval(()=>{},100)'],
      timeoutMs: 100,
    },
  ];
  const { runner, hosts } = await setup([project]);
  try {
    await runner.start();
    await waitFor(() => terminal(runner, 1));
    const run = (await runner.store.runs())[0]!;
    assert.equal(run.outcome, "failed");
    assert.equal(run.validation?.[0]?.exitCode, -1);
    assert.match(await readFile(run.validation![0]!.log, "utf8"), /timed out/);
    assert.equal(hosts.get(project.id)!.changes.length, 0);
  } finally {
    await runner.shutdown();
  }
});

for (const failure of [
  "session",
  "event",
  "branch",
  "commit",
  "read-only",
] as const)
  test(`invocation preserves failure evidence after ${failure} failure`, {
    skip: !databaseUrl,
  }, async () => {
    const { project, git } = await repository();
    const controlled: AgentAdapter = {
      validate: agent.validate,
      async invoke(input) {
        if (failure === "session") await input.session("failing-session");
        else if (failure === "event") {
          // A directory at the log path makes the real event append fail.
          await mkdir(input.processFile!.replace(/\.process\.json$/, ""));
          await input.event({ message: "cannot append" });
        } else {
          await input.session("recorded-session");
          if (failure === "branch") await git("switch", "-c", "unexpected");
          else {
            await writeFile(join(input.cwd, "unexpected.txt"), "changed");
            if (failure === "commit") {
              await git("add", "unexpected.txt");
              await git("commit", "-m", "unexpected commit");
            }
          }
        }
        return "done";
      },
    };
    const { runner } = await setup([project], { codex: controlled });
    const saveInvocation = runner.store.saveInvocation.bind(runner.store);
    let failSessionSave = failure === "session";
    runner.store.saveInvocation = async (record) => {
      if (failSessionSave && record.sessionId) {
        failSessionSave = false;
        throw new Error("session persistence failed");
      }
      await saveInvocation(record);
    };
    runner.options.workflow = async (operations) => {
      await operations.prepare();
      await operations.invoke(
        "characterization",
        project.stages.implementation,
        {
          defaultPrompt: "Exercise invocation boundary",
          readOnly: failure === "read-only",
        },
      );
      await operations.complete();
    };
    try {
      await runner.start();
      await waitFor(() => terminal(runner, 1));
      const [run] = await runner.store.runs();
      const [invocation] = await runner.store.invocations(run!.id);
      assert.equal(invocation!.outcome, "failed");
      assert.ok(invocation!.finishedAt);
      assert.equal(
        invocation!.sessionState,
        failure === "event" ? "unavailable" : "available",
      );
      assert.equal(
        run!.outcome,
        ["branch", "commit", "read-only"].includes(failure)
          ? "blocked"
          : "failed",
      );
      const expected = {
        session: /session persistence failed/,
        event: /EISDIR/,
        branch: /Agent changed branch or committed unexpectedly/,
        commit: /Agent changed branch or committed unexpectedly/,
        "read-only": /Unexpected checkout mutation/,
      };
      assert.match(run!.error!, expected[failure]);
      if (failure === "commit" || failure === "read-only")
        assert.equal(
          await readFile(join(project.checkout, "unexpected.txt"), "utf8"),
          "changed",
        );
    } finally {
      await runner.shutdown();
    }
  });

test("execution timing includes eligibility failures and freezes terminal duration", {
  skip: !databaseUrl,
}, async () => {
  const { project } = await repository();
  const { runner, hosts } = await setup([project]);
  let observedStart: string | undefined;
  hosts.get(project.id)!.getIssue = async () => {
    const [run] = await runner.store.runs();
    assert.equal(run!.outcome, "running");
    observedStart = run!.executions?.at(-1)?.startedAt;
    assert.ok(
      observedStart,
      "Execution starts before eligibility and preparation",
    );
    throw new Error("eligibility unavailable");
  };
  try {
    await runner.start();
    await waitFor(() => terminal(runner, 1));
    const [run] = await runner.store.runs();
    const execution = run!.executions!.at(-1)!;
    assert.ok(observedStart);
    assert.equal(execution.startedAt, observedStart);
    assert.equal(execution.createdAt, run!.createdAt);
    assert.ok(execution.finishedAt);
    await runner.store.patchRun(run!.id, { error: "Additional diagnostic" });
    const later = await runner.store.run(run!.id);
    assert.equal(later.executions!.at(-1)!.finishedAt, execution.finishedAt);
  } finally {
    await runner.shutdown();
  }
});

for (const scenario of [
  "corrected",
  "invalid",
  "provider-failure",
  "mutation",
  "incomplete",
] as const) {
  test(`structured stage outcome: ${scenario}`, {
    skip: !databaseUrl,
  }, async () => {
    const { project } = await repository();
    project.stages.publication.prompt = "Custom publication task";
    const calls: import("../src/domain.js").AgentInvocation[] = [];
    const controlled: AgentAdapter = {
      validate: agent.validate,
      async invoke(input) {
        if (input.step === "publication") {
          calls.push(input);
          assert.match(input.prompt, /Custom publication task/);
          assert.match(input.prompt, /Issue:/);
          assert.match(input.prompt, /Change evidence index:/);
          assert.doesNotMatch(input.prompt, /Prepare a Git commit message/);
          assert.ok(input.outputSchema);
          assert.equal(input.readOnly, true);
          if (scenario === "provider-failure")
            throw new Error("provider failed");
          if (scenario === "mutation")
            await writeFile(join(input.cwd, "unexpected.txt"), "mutation");
          if (
            scenario === "invalid" ||
            (scenario === "corrected" && calls.length === 1) ||
            scenario === "mutation"
          )
            return "not JSON";
        }
        if (input.step === "review" && scenario === "incomplete")
          return JSON.stringify({
            complete: false,
            limitations: ["Could not inspect a dependency"],
            summary: "Partial",
            findings: [{ body: "Partial finding" }],
          });
        return agent.invoke(input);
      },
    };
    const { runner, hosts } = await setup([project], { codex: controlled });
    try {
      await runner.start();
      await waitFor(() => terminal(runner, 1));
      const run = (await runner.store.runs())[0]!;
      const records = (await runner.store.invocations(run.id)).filter(
        (record) => record.step === "publication",
      );
      if (scenario === "corrected") {
        assert.equal(
          run.outcome,
          "completed",
          run.error ?? "unexpected outcome",
        );
        assert.equal(calls.length, 2);
        assert.ok(calls[1]!.timeoutMs! < calls[0]!.timeoutMs!);
        assert.equal(calls[0]!.signal, calls[1]!.signal);
        assert.notEqual(records[0]!.id, records[1]!.id);
        assert.deepEqual(records.map((record) => record.outcome).sort(), [
          "completed",
          "invalid-output",
        ]);
      } else {
        assert.notEqual(run.outcome, "completed");
        assert.equal(calls.length, scenario === "invalid" ? 2 : 1);
        assert.equal(hosts.get(project.id)!.reviews.length, 0);
        if (scenario === "incomplete") {
          assert.equal(run.review?.complete, false);
          assert.equal(run.review?.findings.length, 1);
          assert.match(run.error!, /Incomplete review/);
        } else assert.equal(run.publication, undefined);
      }
    } finally {
      await runner.shutdown();
    }
  });
}
