import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { MonitorSnapshot } from "../packages/cli/src/web/contracts.js";
import { configSchema } from "../packages/core/src/config.js";
import { command } from "../packages/core/src/runtime/process.js";
import { Store } from "../packages/core/src/store.js";
import { repository } from "./fixtures.js";
import { waitFor } from "./runner-fixtures.js";
import { monitorFixture } from "./tui-fixtures.js";

export async function unusedPort() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

export async function seedWebEvidence(
  runner: Awaited<ReturnType<typeof webRunner>>,
  projectId = "fixture",
) {
  const fixture = monitorFixture();
  const now = new Date().toISOString();
  const path = join(runner.config.stateDirectory, "recorded.log");
  await mkdir(runner.config.stateDirectory, { recursive: true });
  await writeFile(
    path,
    '{"type":"message","text":"Recorded agent output"}\nvalidation failed\n',
  );
  const run = {
    ...fixture.run,
    id: randomUUID(),
    taskKey: randomUUID(),
    projectId,
    checkout: runner.config.projects.find(
      (project) => project.id === projectId,
    )!.checkout,
    outcome: "failed" as const,
    phase: "validation",
    error: "Recorded validation failure",
    createdAt: now,
    updatedAt: now,
    validation: [
      {
        command: "check",
        args: [],
        exitCode: 1,
        startedAt: now,
        finishedAt: now,
        log: path,
      },
    ],
    executions: fixture.run.executions!.map((execution) => ({
      ...execution,
      createdAt: now,
      startedAt: now,
      outcome: "failed" as const,
      phase: "validation",
      finishedAt: now,
    })),
  };
  await runner.store.insertRun(run);
  await runner.store.saveInvocation({
    ...fixture.sessions[0]!,
    id: randomUUID(),
    runId: run.id,
    projectId: run.projectId,
    log: path,
    outcome: "completed",
    finishedAt: now,
  });
  await runner.store.emit(run.id, "step", {
    name: "validation",
    status: "failed",
  });
  return { run, path };
}

export async function webRunner(
  options: {
    flags?: string[];
    cli?: string;
    controlledWorkflow?: boolean;
    publicationFailure?: boolean;
    additionalProject?: boolean;
  } = {},
) {
  const { project, root } = await repository();
  const secondary = options.additionalProject ? await repository() : undefined;
  if (secondary) {
    secondary.project.id = "secondary";
    secondary.project.workflows.implementation.enabled = false;
  }
  project.workflows.implementation.enabled =
    options.controlledWorkflow ?? false;
  project.pollIntervalMs = 100;
  if (options.controlledWorkflow) project.hosting.origin = "http://127.0.0.1:1";
  const directory = await mkdtemp(join(tmpdir(), "aw-web-"));
  const config = configSchema.parse({
    id: "web_" + randomUUID().replaceAll("-", ""),
    stateDirectory: join(directory, "state"),
    projects: [project, ...(secondary ? [secondary.project] : [])],
  });
  const configPath = join(directory, "config.json");
  const gate = join(directory, "allow-agent");
  const issue = join(directory, "issue-title");
  const publicationFailure = join(directory, "fail-publication");
  await writeFile(issue, "Controlled fixture work");
  if (options.publicationFailure) await writeFile(publicationFailure, "fail");
  await writeFile(configPath, JSON.stringify(config));
  const port = await unusedPort();
  let output = "";
  const child: ChildProcess = spawn(
    process.execPath,
    [
      ...(options.cli ? [] : ["--import", import.meta.resolve("tsx")]),
      ...(options.controlledWorkflow
        ? ["--import", resolve("tests/fixtures/web-provider-loader.mjs")]
        : []),
      options.cli ?? resolve("packages/cli/src/cli.ts"),
      "--config",
      configPath,
      "run",
      ...(options.flags ?? ["--web-port", String(port)]),
    ],
    {
      cwd: directory,
      env: {
        ...process.env,
        AGENT_WORKFLOWS_DATABASE_URL: process.env.TEST_DATABASE_URL,
        FIXTURE_TOKEN: "fixture-token",
        AW_WEB_TEST_GATE: gate,
        AW_WEB_TEST_ISSUE: issue,
        AW_WEB_TEST_PUBLICATION_FAILURE: publicationFailure,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout!.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr!.on("data", (chunk) => {
    output += chunk;
  });
  const closed = new Promise<void>((done) => child.once("close", () => done()));
  const store = new Store(process.env.TEST_DATABASE_URL!, config.id);
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    await closed;
    await store.close();
    await rm(directory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
    await rm(root + "-remote", { recursive: true, force: true });
    if (secondary) {
      await rm(secondary.root, { recursive: true, force: true });
      await rm(secondary.root + "-remote", { recursive: true, force: true });
    }
  };
  try {
    await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(output);
      return output.includes("started");
    });
    await store.initialize();
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    child,
    store,
    config,
    configPath,
    directory,
    port,
    stop,
    closed,
    gate,
    issue,
    publicationFailure,
    async status(): Promise<MonitorSnapshot> {
      const result = await command(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          resolve("packages/cli/src/cli.ts"),
          "--config",
          configPath,
          "status",
          "--json",
        ],
        {
          cwd: directory,
          env: {
            ...process.env,
            AGENT_WORKFLOWS_DATABASE_URL: process.env.TEST_DATABASE_URL,
          },
        },
      );
      return JSON.parse(result.stdout);
    },
    output: () => output,
    async access() {
      await waitFor(async () => /Web monitor: (http:\/\/\S+)/.test(output));
      const url = /Web monitor: (http:\/\/\S+)/.exec(output)![1]!;
      const response = await fetch(url, { redirect: "manual" });
      const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
      return { url, origin: new URL(url).origin, cookie };
    },
  };
}
