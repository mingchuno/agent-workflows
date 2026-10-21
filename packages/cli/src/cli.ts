#!/usr/bin/env -S node --

import { realpathSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import {
  type Configuration,
  configurationJson,
  createAgents,
  createHosting,
  Runner,
  Store,
  sha256,
  subjectReference,
  workOperator,
} from "@mingchuno/agent-workflows-core";
import { defaultValidationTimeoutMs } from "@mingchuno/agent-workflows-core/operator";
import { Command } from "commander";
import { render } from "ink";
import React from "react";
import {
  loadEnvironmentFile,
  openCliConfiguration,
  readCliConfiguration,
  readConfigurationFile,
} from "./cli-config.js";
import {
  findRunnerControl,
  publishActiveConfiguration,
  publishRunnerControl,
  readActiveConfiguration,
  readRunnerControl,
} from "./cli-runner-control.js";
import { createTerminalNotificationWriter, Monitor } from "./tui/index.js";
import { defaultWebPort } from "./web/contracts.js";
import { startWebMonitor } from "./web/lifecycle.js";
import { registerWorkCommands } from "./work-commands.js";

const launchDirectory = process.cwd();
const packageVersion: string = JSON.parse(
  await readFile(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "../package.json"
        : "../../package.json",
      import.meta.url,
    ),
    "utf8",
  ),
).version;
const program = new Command()
  .name("agent-workflows")
  .description("Local durable issue-to-review workflows")
  .version(packageVersion)
  .option(
    "-c, --config <file>",
    "configuration path (default: $AGENT_WORKFLOWS_CONFIG or agent-workflows.json)",
    process.env.AGENT_WORKFLOWS_CONFIG || "agent-workflows.json",
  )
  .option(
    "--config-base-directory <directory>",
    "base directory for paths contained in configuration",
  );
program
  .command("version")
  .description("Print the installed package version")
  .action(() => console.log(packageVersion));
async function configuration(): Promise<Configuration> {
  return readCliConfiguration(configPath(), (path) =>
    resolve(configBaseDirectory(), path),
  );
}
function configPath(): string {
  return resolve(launchDirectory, program.opts().config);
}
function configBaseDirectory(): string {
  const selected = program.opts().configBaseDirectory as string | undefined;
  const path = selected
    ? resolve(launchDirectory, selected)
    : dirname(configPath());
  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch (error) {
    throw new Error(
      `Configuration path base is not an existing directory: ${path}`,
      { cause: error },
    );
  }
  if (!statSync(canonical).isDirectory())
    throw new Error(
      `Configuration path base is not an existing directory: ${path}`,
    );
  return canonical;
}
function databaseUrl(config: Pick<Configuration, "databaseUrlEnv">): string {
  const value = process.env[config.databaseUrlEnv];
  if (!value)
    throw new Error(`Set ${config.databaseUrlEnv} to a PostgreSQL URL`);
  return value;
}
async function withStore(action: (store: Store) => Promise<void>) {
  const config = await configuration();
  await withConfiguredStore(config, action);
}
async function withConfiguredStore(
  config: Configuration,
  action: (store: Store) => Promise<void>,
) {
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
    const base = configBaseDirectory();
    const checkout = process.cwd();
    const externalState = resolve(
      checkout,
      "..",
      `${basename(checkout)}.agent-workflows`,
    );
    const portable = (path: string) => relative(base, path) || ".";
    const config = {
      id: "local",
      databaseUrlEnv: "AGENT_WORKFLOWS_DATABASE_URL",
      stateDirectory: portable(externalState),
      projects: [
        {
          id: "example",
          checkout: portable(checkout),
          hosting: {
            provider: "github",
            origin: "https://github.com",
            repository: "OWNER/REPOSITORY",
            tokenEnv: "GITHUB_TOKEN",
          },
          workflows: {
            implementation: { enabled: true, labels: ["ready-for-agent"] },
            review: {
              enabled: false,
              labels: ["ready-for-review"],
              rereviewOnPush: false,
            },
          },
          baseBranch: "main",
          branchTemplate: "agent/{issue}-{attempt}",
          includeAgentCoAuthors: true,
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
    await writeFile(configPath(), JSON.stringify(config, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    console.log(
      "Created configuration. Set repository and credentials before running.",
    );
  });
program
  .command("doctor")
  .description(
    "Check the configuration, project, credentials, database and worker that delegated work needs",
  )
  .option(
    "-p, --project <id>",
    "project to check (default: the project whose checkout contains the current directory)",
  )
  .action(async (options: { project?: string }) => {
    const checks: {
      name: string;
      status: "pass" | "warn" | "fail";
      detail: string;
    }[] = [];
    const check = (
      name: string,
      status: "pass" | "warn" | "fail",
      detail: string,
    ) => checks.push({ name, status, detail });
    const report = (project?: string) => {
      const ok = checks.every((item) => item.status !== "fail");
      console.log(
        JSON.stringify(
          {
            ok,
            version: packageVersion,
            configPath: configPath(),
            project,
            protocols: { inline: true, delegated: ok },
            checks,
          },
          null,
          2,
        ),
      );
      if (!ok) process.exitCode = 1;
    };
    let config: Configuration;
    try {
      config = await configuration();
      check("configuration", "pass", configPath());
    } catch (error) {
      check(
        "configuration",
        "fail",
        `${error instanceof Error ? error.message : String(error)}. Run the setup-agent-workflows skill or agent-workflows init.`,
      );
      return report();
    }
    const base = configBaseDirectory();
    const canonical = (path: string) => {
      try {
        return realpathSync(path);
      } catch {
        return resolve(path);
      }
    };
    const here = canonical(launchDirectory);
    const project = options.project
      ? config.projects.find((candidate) => candidate.id === options.project)
      : config.projects.find((candidate) => {
          const checkout = canonical(resolve(base, candidate.checkout));
          return here === checkout || here.startsWith(checkout + "/");
        });
    if (!project) {
      check(
        "project",
        "fail",
        options.project
          ? `Unknown project: ${options.project}`
          : `No configured project checkout contains ${here}`,
      );
      return report();
    }
    check("project", "pass", project.id);
    check(
      "sdlc",
      project.sdlc.enabled ? "pass" : "fail",
      project.sdlc.enabled
        ? `approval source ${project.sdlc.approvalSource}`
        : "Set sdlc.enabled for this project to delegate Track B and C work",
    );
    check(
      "hosting-credentials",
      process.env[project.hosting.tokenEnv] ? "pass" : "fail",
      process.env[project.hosting.tokenEnv]
        ? `${project.hosting.tokenEnv} is set`
        : `Set ${project.hosting.tokenEnv}`,
    );
    try {
      const store = new Store(databaseUrl(config), config.id);
      try {
        await Promise.race([
          store.initialize().then(() => store.projects()),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("Database connection timed out")),
              10_000,
            ).unref(),
          ),
        ]);
        check("database", "pass", "Connected and migrated");
      } finally {
        await store.close();
      }
    } catch (error) {
      check(
        "database",
        "fail",
        error instanceof Error ? error.message : String(error),
      );
    }
    const worker = await findRunnerControl(configPath());
    check(
      "worker",
      worker ? "pass" : "warn",
      worker
        ? `Running as process ${worker.pid}`
        : "Not running; admitted work waits until agent-workflows run starts",
    );
    report(project.id);
  });
program
  .command("config")
  .description("Inspect configuration")
  .command("show")
  .description("Print merged, schema-validated configuration JSON")
  .action(async () => {
    const { envFile: _envFile, ...config } = await readConfigurationFile(
      configPath(),
    );
    process.stdout.write(configurationJson(config));
  });
program
  .command("run")
  .option("-p, --project <ids...>", "run selected project IDs")
  .option("--no-web", "disable the local web monitor")
  .option("--web-port <port>", "local web monitor port", String(defaultWebPort))
  .action(
    async (options: { project?: string[]; web: boolean; webPort: string }) => {
      const webPort = Number(options.webPort);
      if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65535)
        throw new Error("--web-port must be an integer between 1 and 65535");
      const path = configPath();
      const base = configBaseDirectory();
      const source = await openCliConfiguration(path, (path) =>
        resolve(base, path),
      );
      const selectProjects = (config: Configuration): Configuration => {
        if (!options.project) return config;
        const wanted = new Set(options.project);
        for (const id of wanted)
          if (!config.projects.some((project) => project.id === id))
            throw new Error(`Selected project ${id} removed; restart required`);
        return {
          ...config,
          projects: config.projects.filter((project) => wanted.has(project.id)),
        };
      };
      const config = selectProjects(source.config);
      const runner = new Runner({
        pathBaseDirectory: base,
        config,
        reloadConfiguration: async () => selectProjects(await source.reload()),
        publishConfiguration: (configuration) =>
          publishActiveConfiguration(path, configuration),
        databaseUrl: databaseUrl(config),
        hosting: createHosting,
        agents: createAgents(),
      });
      let releaseControl: (() => Promise<void>) | undefined;
      let stopWeb: (() => Promise<void>) | undefined;
      const stopped = new Promise<void>((done) => {
        process.once("SIGINT", done);
        process.once("SIGTERM", done);
      });
      try {
        await runner.start();
        releaseControl = await publishRunnerControl(path, {
          id: config.id,
          databaseUrlEnv: config.databaseUrlEnv,
          databaseUrlHash: sha256(databaseUrl(config)),
          envFile: source.envFile,
          configuration: runner.effectiveConfiguration,
        });
        console.log(
          `Runner ${config.id} started. Use status or monitor in another terminal.`,
        );
        if (options.web) {
          try {
            stopWeb = startWebMonitor({
              config: runner.config,
              configPath: path,
              databaseUrl: databaseUrl(config),
              port: webPort,
            });
          } catch {
            console.error(
              "Web monitor unavailable: could not start server. Workflows continue.",
            );
          }
        }
        await stopped;
      } finally {
        try {
          try {
            await stopWeb?.();
          } finally {
            await runner.shutdown();
          }
        } finally {
          await releaseControl?.();
        }
      }
    },
  );
program
  .command("reload")
  .description(
    "Reload the active runner's original configuration and prompt files",
  )
  .option("--timeout-ms <ms>", "maximum wait for acknowledgement", "10000")
  .action(async (options: { timeoutMs: string }) => {
    const timeoutMs = Number(options.timeoutMs);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
      throw new Error("--timeout-ms must be a positive integer");
    const control = await readRunnerControl(configPath());
    if (control.envFile) await loadEnvironmentFile(control.envFile);
    const connection = databaseUrl(control);
    if (sha256(connection) !== control.databaseUrlHash)
      throw new Error(
        "Database connection differs from the running server; use its startup environment",
      );
    const store = new Store(connection, control.id);
    try {
      await store.initialize();
      const commandId = await store.request("reload", "");
      console.log(JSON.stringify({ commandId, status: "pending" }));
      const deadline = Date.now() + timeoutMs;
      while (true) {
        const command = (await store.commands()).find(
          (item) => item.id === commandId,
        );
        if (command && command.status !== "pending") {
          console.log(JSON.stringify(command));
          if (command.status !== "success") process.exitCode = 1;
          break;
        }
        if (Date.now() >= deadline)
          throw new Error(
            `Reload command ${commandId} is still pending; timeout does not cancel it`,
          );
        await new Promise((done) => setTimeout(done, 100));
      }
    } finally {
      await store.close();
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
              `  ${run.id} ${subjectReference(run.subject)} attempt ${run.attempt}: ${run.outcome} / ${run.phase}`,
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
        ...(!options.invocation
          ? (record.stageLogs?.map((item) => item.path) ?? [])
          : []),
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
for (const kind of ["pause", "resume", "stop", "recover"] as const)
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
program
  .command("retry <target>")
  .description("retry a run through the active runner")
  .option("--refresh-issue", "use the current hosted issue for the new run")
  .action(async (target: string, options: { refreshIssue?: boolean }) =>
    withStore(async (store) => {
      console.log(
        JSON.stringify({
          commandId: await store.request(
            options.refreshIssue ? "retry-refresh" : "retry",
            target,
          ),
          status: "pending",
        }),
      );
    }),
  );
program
  .command("monitor")
  .option("--notify", "notify when an observed execution reaches an outcome")
  .action(async (options: { notify?: boolean }) => {
    const control = await findRunnerControl(configPath());
    if (control?.envFile) await loadEnvironmentFile(control.envFile);
    const config = control?.configuration ?? (await configuration());
    if (control && sha256(databaseUrl(config)) !== control.databaseUrlHash)
      throw new Error(
        "Database connection differs from the running server; use its startup environment",
      );
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new Error(
        "Monitor requires an interactive terminal; use status --json instead",
      );
    await withConfiguredStore(config, async (store) => {
      const work = workOperator({
        store,
        projects: async () =>
          (
            await readActiveConfiguration(configPath(), config.id)
          ).projects.filter((item) =>
            config.projects.some((selected) => selected.id === item.id),
          ),
      });
      await render(
        React.createElement(Monitor, {
          source: {
            workItems: () => work.list(),
            approveWork: (id, approval) => work.approve(id, approval),
            projects: async () =>
              (await store.projects()).filter((project) =>
                config.projects.some((active) => active.id === project.id),
              ),
            runs: async () =>
              (await store.runs()).filter((run) =>
                config.projects.some((project) => project.id === run.projectId),
              ),
            invocations: (id: string) => store.invocations(id),
            events: (after?: number, id?: string) => store.events(after, id),
            commands: () => store.commands(),
            request: (kind: Parameters<Store["request"]>[0], target: string) =>
              store.request(kind, target),
            configuration: () =>
              readActiveConfiguration(configPath(), config.id),
          },
          notificationWriter: options.notify
            ? createTerminalNotificationWriter()
            : undefined,
        }),
        { alternateScreen: true },
      ).waitUntilExit();
    });
  });
registerWorkCommands(program, {
  pathBaseDirectory: configBaseDirectory,
  configuration,
  withStore: withConfiguredStore,
});
try {
  await program.parseAsync();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
