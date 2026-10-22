#!/usr/bin/env -S node --

import { spawn } from "node:child_process";
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
  monitorAddress,
  publishActiveConfiguration,
  publishRunnerControl,
  publishWebUrl,
  readActiveConfiguration,
  readRunnerControl,
} from "./cli-runner-control.js";
import { resolveConfigPath } from "./config-discovery.js";
import { registerDoctor } from "./doctor.js";
import { applyCliTokens } from "./hosting-token.js";
import { inferProject } from "./repository-inference.js";
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
  .description(
    "Durable agent coding workflows. Day to day you need only `run` and `monitor`; start-work drives the rest.",
  )
  .version(packageVersion)
  .option(
    "-c, --config <file>",
    "configuration path (default: $AGENT_WORKFLOWS_CONFIG, ./agent-workflows.json, or the configuration in $AGENT_WORKFLOWS_HOME that manages this checkout)",
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
let discoveredConfigPath: string | undefined;
function configPath(): string {
  discoveredConfigPath ??= resolveConfigPath(
    launchDirectory,
    program.opts().config,
    { discover: true },
  );
  return discoveredConfigPath;
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
function openBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  // Opening is a convenience; the printed link still works.
  spawn(opener, [url], { stdio: "ignore", detached: true })
    .on("error", () => undefined)
    .unref();
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
  .description(
    "Write a configuration inferred from this repository, never overwriting",
  )
  .action(async () => {
    // A new file belongs where the user asked, never in a discovered location.
    discoveredConfigPath = resolveConfigPath(
      launchDirectory,
      program.opts().config,
      { discover: false },
    );
    const base = configBaseDirectory();
    const inferred = inferProject(process.cwd());
    const externalState = resolve(
      inferred.checkout,
      "..",
      `${basename(inferred.checkout)}.agent-workflows`,
    );
    const portable = (path: string) => relative(base, path) || ".";
    const config = {
      id: inferred.id,
      stateDirectory: portable(externalState),
      projects: [
        {
          id: inferred.id,
          checkout: portable(inferred.checkout),
          hosting: inferred.hosting,
          ...(inferred.baseBranch === "main"
            ? {}
            : { baseBranch: inferred.baseBranch }),
          agent: inferred.agent,
          sdlc: { enabled: true, approvalSource: "local-operator" },
          validation: inferred.validation,
        },
      ],
    };
    await writeFile(configPath(), JSON.stringify(config, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    const validation =
      inferred.validation
        .map((item) => [item.command, ...item.args].join(" "))
        .join("; ") || "none found";
    console.log(
      [
        `Created ${configPath()}`,
        `  project     ${inferred.id} (${portable(inferred.checkout)})`,
        `  hosting     ${inferred.hosting.provider} ${inferred.hosting.repository}`,
        `  base        ${inferred.baseBranch}`,
        `  agent       ${inferred.agent.provider}`,
        `  validation  ${validation}`,
        "  approval    local-operator (approve in the monitor)",
        ...(inferred.placeholders.length
          ? [`Replace placeholder: ${inferred.placeholders.join(", ")}`]
          : []),
        "Next: agent-workflows doctor",
      ].join("\n"),
    );
  });
registerDoctor(program, {
  version: packageVersion,
  launchDirectory,
  configPath,
  configBaseDirectory,
  configuration,
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
  .description("Start the worker and the web monitor; keep it running")
  .option("-p, --project <ids...>", "run selected project IDs")
  .option("--no-web", "disable the local web monitor")
  .option(
    "--web-port <port>",
    `local web monitor port (default: ${defaultWebPort}, or a free port when it is taken)`,
  )
  .action(
    async (options: { project?: string[]; web: boolean; webPort?: string }) => {
      const webPort = Number(options.webPort ?? defaultWebPort);
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
              fallbackPort: options.webPort === undefined,
              onReady: (url) =>
                void publishWebUrl(path, url).catch(() => undefined),
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
  .description("Show projects, runs and command outcomes")
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
program
  .command("inspect <run>")
  .description("Print a run and its invocations as JSON")
  .action(async (run: string) =>
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
  .description("Print a run's stage, agent and validation logs")
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
  .description("Open the terminal monitor: runs, Work Items and approvals")
  .option("--notify", "notify when an observed execution reaches an outcome")
  .option(
    "--web [workItem]",
    "open the running web monitor instead, optionally at a Work Item",
  )
  .action(async (options: { notify?: boolean; web?: boolean | string }) => {
    const control = await findRunnerControl(configPath());
    if (options.web) {
      if (!control?.webUrl)
        throw new Error(
          "No web monitor is running for this configuration; start agent-workflows run",
        );
      const url =
        typeof options.web === "string"
          ? `${control.webUrl}#work=${encodeURIComponent(options.web)}`
          : control.webUrl;
      console.log(`Web monitor: ${url}`);
      if (process.stdout.isTTY) openBrowser(url);
      return;
    }
    if (control?.envFile) await loadEnvironmentFile(control.envFile);
    const config = control?.configuration ?? (await configuration());
    applyCliTokens(config.projects);
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
        stateDirectory: resolve(configBaseDirectory(), config.stateDirectory),
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
            resubmitWork: (id, revision) => work.resubmit(id, revision),
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
  launchDirectory,
  pathBaseDirectory: configBaseDirectory,
  configuration,
  monitorUrl: async () => {
    const webUrl = (await findRunnerControl(configPath()))?.webUrl;
    return webUrl && monitorAddress(webUrl);
  },
  withStore: withConfiguredStore,
});
// Help lists groups in command order, so daily commands come first.
const helpGroups = [
  ["Daily:", ["run", "monitor"]],
  ["Setup:", ["init", "doctor", "config", "version"]],
  ["Operator controls:", []],
  ["Used by the start-work skill:", ["work"]],
] as const;
const helpRank = (name: string) => {
  const rank = helpGroups.findIndex(([, names]) =>
    (names as readonly string[]).includes(name),
  );
  return rank === -1 ? 2 : rank;
};
(program.commands as Command[]).sort(
  (a, b) => helpRank(a.name()) - helpRank(b.name()),
);
for (const command of program.commands)
  command.helpGroup(helpGroups[helpRank(command.name())]![0]);
try {
  await program.parseAsync();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
