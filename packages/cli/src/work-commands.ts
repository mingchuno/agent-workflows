import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  admitWork,
  assertCheckoutReleased,
  BlockedError,
  type Configuration,
  changedPathsSince,
  classifyWork,
  createHosting,
  gateSchema,
  issueSource,
  type Project,
  publishWork,
  type Store,
  syncWorkApprovals,
  type WorkInspection,
  workContractSchema,
  workOperator,
} from "@mingchuno/agent-workflows-core";
import type { Command } from "commander";
import { withinCheckout } from "./config-discovery.js";

interface WorkCommandDependencies {
  launchDirectory: string;
  pathBaseDirectory(): string;
  configuration(): Promise<Configuration>;
  /** The running web monitor address without its token, if any. */
  monitorUrl(): Promise<string | undefined>;
  withStore(
    config: Configuration,
    action: (store: Store) => Promise<void>,
  ): Promise<void>;
}
/** Read JSON from a file, or from standard input for `-`. */
async function readJson(path: string): Promise<unknown> {
  if (path !== "-") return JSON.parse(await readFile(path, "utf8"));
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return JSON.parse(text);
}

export function registerWorkCommands(
  program: Command,
  dependencies: WorkCommandDependencies,
): void {
  const work = program
    .command("work")
    .description("Assess, approve and submit revision-bound engineering work");
  const resolveProject = async (projectId: string | undefined) => {
    const authored = await dependencies.configuration();
    const base = dependencies.pathBaseDirectory();
    const config = {
      ...authored,
      stateDirectory: resolve(base, authored.stateDirectory),
      projects: await Promise.all(
        authored.projects.map(async (project) => ({
          ...project,
          checkout: await realpath(resolve(base, project.checkout)),
        })),
      ),
    };
    // Without --project, use the project whose checkout holds this directory.
    const project = config.projects.find((candidate) =>
      projectId === undefined
        ? withinCheckout(dependencies.launchDirectory, candidate.checkout)
        : candidate.id === projectId,
    );
    if (!project)
      throw new Error(
        projectId === undefined
          ? `No configured project checkout contains ${dependencies.launchDirectory}; pass --project`
          : `Unknown project: ${projectId}`,
      );
    return { config, project };
  };
  const execute = async (
    projectId: string | undefined,
    action: (
      store: Store,
      project: Project,
      config: Configuration,
    ) => Promise<unknown>,
  ) => {
    const { config, project } = await resolveProject(projectId);
    if (!project.sdlc.enabled)
      throw new Error("Enable sdlc for this project first");
    await dependencies.withStore(config, async (store) => {
      await store.registerProject(project.id);
      const result = await action(store, project, config);
      // Point the human at the Work Item in the web monitor, if it runs.
      const monitor = await dependencies.monitorUrl();
      const linked =
        monitor && result && typeof result === "object" && "work" in result
          ? {
              ...result,
              monitorUrl: `${monitor}#work=${encodeURIComponent((result as WorkInspection).work.id)}`,
            }
          : result;
      console.log(JSON.stringify(linked));
    });
  };
  const command = (syntax: string) =>
    work
      .command(syntax)
      .option(
        "-p, --project <id>",
        "configured project ID (default: the project containing the current directory)",
      )
      .option("--json", "machine-readable output (default)");
  command("create")
    .option("--issue <number>", "fetch an issue from the configured host")
    .option("--title <text>", "local task title and initial intent")
    .option("--key <key>", "stable local intake key; reuse to resume")
    .option(
      "--file <path>",
      "initial WorkContract JSON, or - for standard input",
    )
    .action(
      async (options: {
        project?: string;
        issue?: string;
        title?: string;
        key?: string;
        file?: string;
      }) =>
        execute(options.project, async (store, project) => {
          if (options.issue && (options.title || options.key))
            throw new Error("Choose issue-backed or local intake");
          if (options.issue) {
            const number = Number(options.issue);
            if (!Number.isSafeInteger(number) || number < 1)
              throw new Error("Issue must be a positive integer");
            const issue = await createHosting(project).getIssue(number);
            if (!issue.open) throw new Error("Issue is closed");
            const contract = options.file
              ? await readJson(options.file)
              : { title: issue.title, intent: issue.body || issue.title };
            const work = await store.workItems.create(
              project.id,
              issueSource(project.hosting.provider, issue),
              contract,
            );
            return store.workItems.inspect(work.id, project);
          }
          if (!project.sdlc.allowLocalTasks)
            throw new Error("Local tasks are disabled by policy");
          if (!options.title && !options.file)
            throw new Error("Provide --title or --file for local work");
          const contract = options.file
            ? await readJson(options.file)
            : { title: options.title, intent: options.title };
          const created = await store.workItems.create(
            project.id,
            { kind: "local", key: options.key ?? randomUUID() },
            contract,
          );
          return store.workItems.inspect(created.id, project);
        }),
    );
  command("classify")
    .description(
      "Classify a contract without the database; Track A runs inline in the current session",
    )
    .requiredOption(
      "--file <path>",
      "WorkContract JSON, or - for standard input",
    )
    .option(
      "--changed-from <revision>",
      "also check the checkout's changes since this revision",
    )
    .action(
      async (options: {
        project?: string;
        file: string;
        changedFrom?: string;
      }) => {
        const { project } = await resolveProject(options.project);
        const contract = workContractSchema.parse(await readJson(options.file));
        const changed =
          options.changedFrom === undefined
            ? undefined
            : await changedPathsSince(project.checkout, options.changedFrom);
        console.log(
          JSON.stringify(classifyWork(contract, project.sdlc, changed)),
        );
      },
    );
  command("list")
    .option("--brief", "one summary line of state per Work Item")
    .action(async (options: { project?: string; brief?: boolean }) =>
      execute(options.project, async (store, project) => {
        const items = await Promise.all(
          (await store.workItems.list(project.id)).map((item) =>
            store.workItems.inspect(item.id, project),
          ),
        );
        return options.brief
          ? items.map(({ work, decision, approvalComment }) => ({
              id: work.id,
              title: work.contract.title,
              source:
                work.source.kind === "local"
                  ? `local:${work.source.key}`
                  : work.source.url,
              track: decision.track,
              state: decision.state,
              ...(approvalComment ? { approvalComment } : {}),
            }))
          : items;
      }),
    );
  for (const verb of ["inspect", "assess"])
    command(`${verb} <id>`).action(
      async (id: string, options: { project?: string }) =>
        execute(options.project, (store, project) =>
          store.workItems.inspect(id, project),
        ),
    );
  command("propose <id>")
    .requiredOption("--revision <digest>", "revision being replaced")
    .option(
      "--publish",
      "then write the contract to its issue; only after the human confirmed publishing",
    )
    .requiredOption(
      "--file <path>",
      "complete authored WorkContract JSON, or - for standard input",
    )
    .action(
      async (
        id: string,
        options: {
          project?: string;
          revision: string;
          file: string;
          publish?: boolean;
        },
      ) =>
        execute(options.project, async (store, project) => {
          await store.workItems.inspect(id, project);
          const contract = workContractSchema.parse(
            await readJson(options.file),
          );
          const proposed = await store.workItems.propose(
            id,
            options.revision,
            contract,
          );
          return options.publish
            ? publishWork(
                id,
                project,
                { store, hosting: createHosting(project) },
                { revision: proposed.revision },
              )
            : store.workItems.inspect(id, project);
        }),
    );
  command("approve <id>")
    .description(
      "Record deliberate local human approval; never invoke from an intake skill",
    )
    .requiredOption(
      "--revision <digest>",
      "complete contract revision inspected by the operator",
    )
    .requiredOption("--gate <gate>", "scope or design")
    .action(
      async (
        id: string,
        options: { project?: string; revision: string; gate: string },
      ) =>
        execute(options.project, (store, project) =>
          workOperator({ store, projects: async () => [project] }).approve(id, {
            gate: gateSchema.parse(options.gate),
            revision: options.revision,
          }),
        ),
    );
  command("publish <id>")
    .description(
      "Write the contract to its issue, creating one for local work; only after the human confirms",
    )
    .requiredOption("--revision <digest>", "contract revision to publish")
    .action(
      async (id: string, options: { project?: string; revision: string }) =>
        execute(options.project, (store, project) =>
          publishWork(
            id,
            project,
            { store, hosting: createHosting(project) },
            { revision: options.revision },
          ),
        ),
    );
  command("sync-approvals <id>").action(
    async (id: string, options: { project?: string }) =>
      execute(options.project, async (store, project) => ({
        imported: await syncWorkApprovals(
          id,
          project,
          store,
          createHosting(project),
        ),
        ...(await store.workItems.inspect(id, project)),
      })),
  );
  command("submit <id>")
    .requiredOption("--revision <digest>", "approved contract revision")
    .option(
      "--recover",
      "admit a new revision after checking stopped work and a clean checkout",
    )
    .action(
      async (
        id: string,
        options: { project?: string; revision: string; recover?: boolean },
      ) =>
        execute(options.project, async (store, project, config) => {
          const admission = await admitWork(
            id,
            project,
            { store, hosting: () => createHosting(project) },
            {
              revision: options.revision,
              recovery: options.recover
                ? {
                    checkSafety: (related) =>
                      assertCheckoutReleased({
                        project,
                        stateDirectory: config.stateDirectory,
                        runIds: related.map((run) => run.id),
                      }),
                  }
                : undefined,
            },
          );
          if (admission.state === "waiting")
            throw new BlockedError(admission.reason);
          return { run: admission.run };
        }),
    );
}
