import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { openCliConfiguration } from "../src/cli-config.js";
import { configSchema } from "../src/config.js";
import type { AgentInvocation } from "../src/domain.js";
import { Runner } from "../src/runner.js";
import { ExistingCheckout } from "../src/workspace.js";
import { repository } from "./fixtures.js";
import { agent, FixtureHosting, waitFor } from "./runner-fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

async function acknowledgedReload(runner: Runner) {
  const id = await runner.store.request("reload", "");
  await waitFor(async () =>
    (await runner.store.commands()).some(
      (command) => command.id === id && command.status !== "pending",
    ),
  );
  return (await runner.store.commands()).find((command) => command.id === id)!;
}

test("reload keeps active execution inputs and applies new settings to queued work", {
  skip: !databaseUrl,
}, async () => {
  const { project } = await repository();
  const directory = await mkdtemp(join(tmpdir(), "aw-reload-"));
  const promptPath = join(directory, "publication.md");
  await writeFile(promptPath, "Original publication task");
  project.agent.model = "original-model";
  project.stages.publication.promptFile = "publication.md";
  const config = configSchema.parse({
    id: "reload_" + randomUUID().replaceAll("-", ""),
    stateDirectory: join(directory, "state"),
    projects: [project],
  });
  const configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  const source = await openCliConfiguration(configPath, (path) =>
    join(directory, path),
  );
  const hosting = new FixtureHosting();
  hosting.issues.push({
    ...hosting.issues[0]!,
    id: "2",
    number: 2,
    url: "https://fixture.invalid/2",
  });
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const calls: AgentInvocation[] = [];
  let implementations = 0;
  const runner = new Runner({
    config,
    pathBaseDirectory: directory,
    databaseUrl: databaseUrl!,
    reloadConfiguration: source.reload,
    hosting: () => hosting,
    agents: {
      codex: {
        validate: agent.validate,
        async invoke(input) {
          calls.push(input);
          if (input.step === "implementation") {
            implementations++;
            if (implementations === 1) await gate;
            await writeFile(
              join(input.cwd, `task-${implementations}.txt`),
              "implemented\n",
            );
          }
          return agent.invoke(input);
        },
      },
    },
  });
  try {
    await runner.start();
    await waitFor(
      async () =>
        implementations === 1 && (await runner.store.runs()).length === 2,
    );
    await writeFile(promptPath, "Reloaded publication task");
    config.projects[0]!.agent.model = "reloaded-model";
    config.projects[0]!.stages.implementation.prompt =
      "Reloaded implementation task";
    config.projects[0]!.validation = [
      {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        timeoutMs: 10_000,
      },
    ];
    await writeFile(configPath, JSON.stringify(config));
    assert.equal((await acknowledgedReload(runner)).status, "success");
    release();
    await waitFor(async () =>
      (await runner.store.runs()).every((run) => run.outcome === "completed"),
    );
    const publications = calls.filter((call) => call.step === "publication");
    assert.equal(publications[0]!.profile.model, "original-model");
    assert.match(publications[0]!.prompt, /Original publication task/);
    assert.equal(publications[1]!.profile.model, "reloaded-model");
    assert.match(publications[1]!.prompt, /Reloaded publication task/);
    const implementation = calls.filter(
      (call) => call.step === "implementation",
    )[1]!;
    assert.match(implementation.prompt, /Reloaded implementation task/);
    const runs = (await runner.store.runs()).sort(
      (a, b) => a.subject.number - b.subject.number,
    );
    assert.equal(runs[0]!.validation?.length ?? 0, 0);
    assert.deepEqual(
      runs[1]!.validation?.map((check) => check.exitCode),
      [0],
    );
  } finally {
    release();
    await runner.shutdown();
  }
});

test("reload acknowledgement waits for scans using the previous configuration", {
  skip: !databaseUrl,
}, async () => {
  const { project } = await repository();
  let scans = 0;
  let readingConfiguration = false;
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  class Hosting extends FixtureHosting {
    override async listIssues() {
      scans++;
      await gate;
      return [];
    }
  }
  const config = configSchema.parse({
    id: "scan_" + randomUUID().replaceAll("-", ""),
    stateDirectory: await mkdtemp(join(tmpdir(), "aw-reload-scan-")),
    projects: [project],
  });
  const runner = new Runner({
    config,
    databaseUrl: databaseUrl!,
    hosting: () => new Hosting(),
    agents: { codex: agent },
    reloadConfiguration: async () => {
      readingConfiguration = true;
      return config;
    },
  });
  try {
    await runner.start();
    await waitFor(async () => scans === 1);
    config.projects[0]!.workflows.implementation.enabled = false;
    const id = await runner.store.request("reload", "");
    await waitFor(async () => readingConfiguration);
    assert.equal(
      (await runner.store.commands()).find((item) => item.id === id)!.status,
      "pending",
    );
    await runner.poll();
    assert.equal(scans, 1);
    release();
    await waitFor(
      async () =>
        (await runner.store.commands()).find((item) => item.id === id)
          ?.status === "success",
    );
    await runner.poll();
    assert.equal(scans, 1);
    assert.equal((await runner.store.runs()).length, 0);
  } finally {
    release();
    await runner.shutdown();
  }
});

test("changed execution inputs after reload still reject publication recovery", {
  skip: !databaseUrl,
}, async () => {
  const { project } = await repository();
  const config = configSchema.parse({
    id: "recovery_reload_" + randomUUID().replaceAll("-", ""),
    stateDirectory: await mkdtemp(join(tmpdir(), "aw-reload-recovery-")),
    projects: [project],
  });
  class Checkout extends ExistingCheckout {
    override async push() {
      throw new Error("Remote unavailable");
    }
  }
  const runner = new Runner({
    config,
    databaseUrl: databaseUrl!,
    hosting: () => new FixtureHosting(),
    agents: { codex: agent },
    workspace: new Checkout(),
    reloadConfiguration: async () => config,
  });
  try {
    await runner.start();
    await waitFor(
      async () => (await runner.store.runs())[0]?.outcome === "failed",
    );
    const run = (await runner.store.runs())[0]!;
    await waitFor(
      async () => (await DBOS.getWorkflowStatus(run.id))?.status === "SUCCESS",
    );
    config.projects[0]!.stages.publication.prompt =
      "Changed publication instructions";
    assert.equal((await acknowledgedReload(runner)).status, "success");
    await assert.rejects(
      runner.recover(run.id),
      /Execution configuration or prompts changed; use retry/,
    );
    assert.equal((await runner.store.run(run.id)).executions!.length, 1);
  } finally {
    await runner.shutdown();
  }
});

test("failed reloads preserve the active configuration and environment", {
  skip: !databaseUrl,
}, async () => {
  const { project } = await repository();
  project.workflows.implementation.enabled = false;
  const directory = await mkdtemp(join(tmpdir(), "aw-reload-rejected-"));
  const configPath = join(directory, "config.json");
  const environmentKey =
    "AW_RELOAD_" + randomUUID().replaceAll("-", "").toUpperCase();
  const envPath = join(directory, "runner.env");
  await writeFile(envPath, `${environmentKey}=original-value\n`);
  await writeFile(join(directory, "blank.md"), " \n");
  await writeFile(join(directory, "invalid-utf8.md"), Buffer.from([0xff]));
  const config = configSchema.parse({
    id: "rejected_" + randomUUID().replaceAll("-", ""),
    stateDirectory: join(directory, "state"),
    projects: [project],
  });
  await writeFile(
    configPath,
    JSON.stringify({ ...config, envFile: "runner.env" }),
  );
  const source = await openCliConfiguration(configPath, (path) =>
    join(directory, path),
  );
  const runner = new Runner({
    config: source.config,
    pathBaseDirectory: directory,
    databaseUrl: databaseUrl!,
    reloadConfiguration: source.reload,
    hosting: () => new FixtureHosting(),
    agents: { codex: agent },
  });
  try {
    await runner.start();
    const original = runner.config;
    const cases: Array<{
      name: string;
      edit: (candidate: typeof config & { envFile: string }) => void;
      error: RegExp;
    }> = [
      {
        name: "runner ID",
        edit: (next) => {
          next.id = "other";
        },
        error: /require restart: id/,
      },
      {
        name: "database selector",
        edit: (next) => {
          next.databaseUrlEnv = "OTHER_DATABASE_URL";
        },
        error: /require restart: databaseUrlEnv/,
      },
      {
        name: "state directory",
        edit: (next) => {
          next.stateDirectory = join(directory, "other-state");
        },
        error: /require restart: stateDirectory/,
      },
      {
        name: "project removed",
        edit: (next) => {
          next.projects[0]!.id = "other";
        },
        error: /require restart: projects/,
      },
      {
        name: "project added",
        edit: (next) => {
          next.projects.push({ ...next.projects[0]!, id: "added" });
        },
        error: /require restart: projects/,
      },
      {
        name: "checkout",
        edit: (next) => {
          next.projects[0]!.checkout = directory;
        },
        error: /require restart: projects.fixture.checkout/,
      },
      {
        name: "hosting",
        edit: (next) => {
          next.projects[0]!.hosting.repository = "other/repository";
        },
        error: /require restart: projects.fixture.hosting.repository/,
      },
      {
        name: "credential selector",
        edit: (next) => {
          next.projects[0]!.hosting.tokenEnv = "OTHER_TOKEN";
        },
        error: /require restart: projects.fixture.hosting.tokenEnv/,
      },
      {
        name: "environment source",
        edit: (next) => {
          next.envFile = "missing.env";
        },
        error: /require restart: envFile/,
      },
      {
        name: "missing prompt",
        edit: (next) => {
          next.projects[0]!.stages.review.promptFile = "missing.md";
        },
        error: /Cannot read UTF-8 promptFile/,
      },
      {
        name: "blank prompt",
        edit: (next) => {
          next.projects[0]!.stages.review.promptFile = "blank.md";
        },
        error: /Stage prompt must be nonblank/,
      },
      {
        name: "invalid UTF-8 prompt",
        edit: (next) => {
          next.projects[0]!.stages.review.promptFile = "invalid-utf8.md";
        },
        error: /Cannot read UTF-8 promptFile/,
      },
      {
        name: "invalid schema",
        edit: (next) => {
          next.projects[0]!.pollIntervalMs = 0;
        },
        error: /pollIntervalMs/,
      },
    ];
    for (const scenario of cases) {
      const next = { ...structuredClone(config), envFile: "runner.env" };
      next.projects[0]!.agent.model = "must-not-apply";
      scenario.edit(next);
      await writeFile(configPath, JSON.stringify(next));
      const result = await acknowledgedReload(runner);
      assert.equal(result.status, "failed", scenario.name);
      assert.match(result.error!, scenario.error, scenario.name);
      assert.equal(runner.config, original, scenario.name);
    }
    await writeFile(configPath, "{invalid JSON");
    assert.equal((await acknowledgedReload(runner)).status, "failed");
    assert.equal(runner.config, original);
    await writeFile(
      configPath,
      JSON.stringify({ ...config, envFile: "runner.env" }),
    );
    await writeFile(envPath, `${environmentKey}=changed-value\n`);
    assert.equal((await acknowledgedReload(runner)).status, "success");
    assert.equal(process.env[environmentKey], "original-value");
  } finally {
    await runner.shutdown();
    delete process.env[environmentKey];
  }
});
