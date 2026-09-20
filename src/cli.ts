#!/usr/bin/env -S node --
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { parseEnv } from "node:util";
import { Command } from "commander";
import { render } from "ink";
import React from "react";
import { createAgents } from "./adapters/agents.js";
import { createHosting } from "./adapters/hosting.js";
import { type Configuration, configSchema } from "./config.js";
import { defaultValidationTimeoutMs } from "./defaults.js";
import { Runner } from "./runner.js";
import { Store } from "./store.js";
import { Monitor } from "./tui/index.js";

const launchDirectory = process.cwd();
const program = new Command()
  .name("agent-workflows")
  .description("Local durable issue-to-review workflows")
  .option("-c, --config <file>", "configuration path", "agent-workflows.json")
  .option(
    "--env-file <path>",
    "load literal dotenv values; existing environment wins",
  )
  .hook("preAction", async () => {
    const path = program.opts().envFile as string | undefined;
    if (path === undefined) return;
    const file = resolve(launchDirectory, path);
    let contents: string;
    try {
      contents = await readFile(file, "utf8");
    } catch (error) {
      throw new Error(
        `Cannot read environment file ${file} (${(error as NodeJS.ErrnoException).code ?? "read failed"})`,
      );
    }
    for (const [name, value] of Object.entries(parseEnv(contents))) {
      if (process.env[name] === undefined) process.env[name] = value;
    }
  });
async function configuration(): Promise<Configuration> {
  return configSchema.parse(
    JSON.parse(await readFile(resolve(program.opts().config), "utf8")),
  );
}
function databaseUrl(config: Configuration): string {
  const value = process.env[config.databaseUrlEnv];
  if (!value)
    throw new Error(`Set ${config.databaseUrlEnv} to a PostgreSQL URL`);
  return value;
}
async function withStore(action: (store: Store) => Promise<void>) {
  const config = await configuration();
  const store = new Store(databaseUrl(config), config.id);
  try {
    await store.initialize();
    await action(store);
  } finally {
    await store.close();
  }
}
program
  .command("init")
  .description("Write a configuration scaffold without overwriting files")
  .action(async () => {
    const config = {
      id: "local",
      databaseUrlEnv: "AGENT_WORKFLOWS_DATABASE_URL",
      stateDirectory: resolve(
        "..",
        `${basename(process.cwd())}.agent-workflows`,
      ),
      projects: [
        {
          id: "example",
          checkout: process.cwd(),
          hosting: {
            provider: "github",
            origin: "https://github.com",
            repository: "OWNER/REPOSITORY",
            tokenEnv: "GITHUB_TOKEN",
          },
          labels: ["ready-for-agent"],
          baseBranch: "main",
          branchTemplate: "agent/{issue}-{attempt}",
          gitIdentity: { name: "YOUR NAME", email: "you@example.com" },
          agent: { provider: "codex" },
          validation: [
            {
              command: "pnpm",
              args: ["test"],
              timeoutMs: defaultValidationTimeoutMs,
            },
          ],
          stages: { implementation: {}, publication: {}, review: {} },
        },
      ],
    };
    await writeFile(
      resolve(program.opts().config),
      JSON.stringify(config, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    console.log(
      "Created configuration. Set repository, checkout, identity and credentials before running.",
    );
  });
program
  .command("run")
  .option("-p, --project <ids...>", "run selected project IDs")
  .action(async (options: { project?: string[] }) => {
    const config = await configuration();
    if (options.project) {
      const wanted = new Set(options.project);
      for (const id of wanted)
        if (!config.projects.some((project) => project.id === id))
          throw new Error(`Unknown project ${id}`);
      config.projects = config.projects.filter((project) =>
        wanted.has(project.id),
      );
    }
    const runner = new Runner({
      promptBaseDirectory: dirname(resolve(program.opts().config)),
      config,
      databaseUrl: databaseUrl(config),
      hosting: createHosting,
      agents: createAgents(),
    });
    try {
      await runner.start();
      console.log(
        `Runner ${config.id} started. Use status or monitor in another terminal.`,
      );
      await new Promise<void>((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
      });
    } finally {
      await runner.shutdown();
    }
  });
program
  .command("status")
  .option("--json", "machine-readable output")
  .action(async (options: { json?: boolean }) =>
    withStore(async (store) => {
      const status = {
        projects: await store.projects(),
        runs: await store.runs(),
        commands: await store.commands(),
      };
      if (options.json) console.log(JSON.stringify(status));
      else
        for (const project of status.projects) {
          console.log(
            `${project.id}: ${project.blocked ? "blocked" : project.paused ? "paused" : "enabled"}`,
          );
          for (const run of status.runs.filter(
            (run) => run.projectId === project.id,
          ))
            console.log(
              `  ${run.id} #${run.issue.number} attempt ${run.attempt}: ${run.outcome} / ${run.phase}`,
            );
        }
    }),
  );
program.command("inspect <run>").action(async (run: string) =>
  withStore(async (store) =>
    console.log(
      JSON.stringify(
        {
          run: await store.run(run),
          invocations: await store.invocations(run),
          recovery: await store.recoveryPlan(run),
        },
        null,
        2,
      ),
    ),
  ),
);
program
  .command("logs <run>")
  .option("--invocation <id>", "specific invocation")
  .action(async (run: string, options: { invocation?: string }) =>
    withStore(async (store) => {
      const record = await store.run(run);
      const invocations = (await store.invocations(run)).filter(
        (item) => !options.invocation || item.id === options.invocation,
      );
      const paths = [
        ...invocations.map((item) => item.log),
        ...(!options.invocation
          ? (record.validation?.map((check) => check.log) ?? [])
          : []),
      ];
      for (const path of paths) {
        console.log(`--- ${path}`);
        try {
          console.log(await readFile(path, "utf8"));
        } catch {
          console.log("Artifact unavailable");
        }
      }
    }),
  );
for (const kind of ["pause", "resume", "stop", "retry", "recover"] as const)
  program
    .command(`${kind} <target>`)
    .description(`${kind} project or run through the active runner`)
    .action(async (target: string) =>
      withStore(async (store) => {
        console.log(
          JSON.stringify({
            commandId: await store.request(kind, target),
            status: "pending",
          }),
        );
      }),
    );
program.command("monitor").action(async () => {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "Monitor requires an interactive terminal; use status --json instead",
    );
  await withStore(async (store) => {
    await render(React.createElement(Monitor, { source: store }), {
      alternateScreen: true,
    }).waitUntilExit();
  });
});
try {
  await program.parseAsync();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
