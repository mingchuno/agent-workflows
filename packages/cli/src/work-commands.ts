import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertCheckoutReleased,
  type Configuration,
  changedPathsSince,
  classifyWork,
  createHosting,
  gateSchema,
  issueSource,
  type Project,
  type Store,
  syncWorkApprovals,
  workContractSchema,
  workOperator,
} from "@mingchuno/agent-workflows-core";
import type { Command } from "commander";

interface WorkCommandDependencies {
  pathBaseDirectory(): string;
  configuration(): Promise<Configuration>;
  withStore(
    config: Configuration,
    action: (store: Store) => Promise<void>,
  ): Promise<void>;
}
export function registerWorkCommands(
  program: Command,
  dependencies: WorkCommandDependencies,
): void {
  const work = program
    .command("work")
    .description("Assess, approve and submit revision-bound engineering work");
  const resolveProject = async (projectId: string) => {
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
    const project = config.projects.find(
      (candidate) => candidate.id === projectId,
    );
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    return { config, project };
  };
  const execute = async (
    projectId: string,
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
      console.log(
        JSON.stringify(await action(store, project, config), null, 2),
      );
    });
  };
  const command = (syntax: string) =>
    work
      .command(syntax)
      .requiredOption("-p, --project <id>", "configured project ID")
      .option("--json", "machine-readable output (default)");
  command("create")
    .option("--issue <number>", "fetch an issue from the configured host")
    .option("--title <text>", "local task title and initial intent")
    .option("--key <key>", "stable local intake key; reuse to resume")
    .option("--file <path>", "initial WorkContract JSON")
    .action(
      async (options: {
        project: string;
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
              ? JSON.parse(await readFile(options.file, "utf8"))
              : { title: issue.title, intent: issue.body || issue.title };
            const work = await store.workItems.create(
              project.id,
              issueSource(project.hosting.provider, issue),
              contract,
            );
            await store.workItems.refreshSource(
              work.id,
              issueSource(project.hosting.provider, issue),
            );
            return store.workItems.inspect(work.id, project);
          }
          if (!project.sdlc.allowLocalTasks)
            throw new Error("Local tasks are disabled by policy");
          if (!options.title && !options.file)
            throw new Error("Provide --title or --file for local work");
          const contract = options.file
            ? JSON.parse(await readFile(options.file, "utf8"))
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
    .requiredOption("--file <path>", "WorkContract JSON")
    .option(
      "--changed-from <revision>",
      "also check the checkout's changes since this revision",
    )
    .action(
      async (options: {
        project: string;
        file: string;
        changedFrom?: string;
      }) => {
        const { project } = await resolveProject(options.project);
        const contract = workContractSchema.parse(
          JSON.parse(await readFile(options.file, "utf8")),
        );
        const changed =
          options.changedFrom === undefined
            ? undefined
            : await changedPathsSince(project.checkout, options.changedFrom);
        console.log(
          JSON.stringify(
            classifyWork(contract, project.sdlc, changed),
            null,
            2,
          ),
        );
      },
    );
  command("list").action(async (options: { project: string }) =>
    execute(options.project, async (store, project) =>
      Promise.all(
        (await store.workItems.list(project.id)).map((item) =>
          store.workItems.inspect(item.id, project),
        ),
      ),
    ),
  );
  for (const verb of ["inspect", "assess"])
    command(`${verb} <id>`).action(
      async (id: string, options: { project: string }) =>
        execute(options.project, (store, project) =>
          store.workItems.inspect(id, project),
        ),
    );
  command("propose <id>")
    .requiredOption("--revision <digest>", "revision being replaced")
    .requiredOption("--file <path>", "complete authored WorkContract JSON")
    .action(
      async (
        id: string,
        options: { project: string; revision: string; file: string },
      ) =>
        execute(options.project, async (store, project) => {
          await store.workItems.inspect(id, project);
          const contract = workContractSchema.parse(
            JSON.parse(await readFile(options.file, "utf8")),
          );
          await store.workItems.propose(id, options.revision, contract);
          return store.workItems.inspect(id, project);
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
        options: { project: string; revision: string; gate: string },
      ) =>
        execute(options.project, (store, project) =>
          workOperator({ store, projects: async () => [project] }).approve(id, {
            gate: gateSchema.parse(options.gate),
            revision: options.revision,
          }),
        ),
    );
  command("sync-approvals <id>").action(
    async (id: string, options: { project: string }) =>
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
        options: { project: string; revision: string; recover?: boolean },
      ) =>
        execute(options.project, async (store, project, config) => {
          const { work } = await store.workItems.inspect(id, project);
          if (work.source.kind !== "local") {
            const issue = await createHosting(project).getIssue(
              work.source.number,
            );
            if (!issue.open) throw new Error("Issue is closed");
            await store.workItems.refreshSource(
              id,
              issueSource(project.hosting.provider, issue),
            );
          }
          return {
            run: await store.workItems.submit(
              id,
              options.revision,
              project,
              options.recover
                ? {
                    checkSafety: (related) =>
                      assertCheckoutReleased({
                        project,
                        stateDirectory: config.stateDirectory,
                        runIds: related.map((run) => run.id),
                      }),
                  }
                : undefined,
            ),
          };
        }),
    );
}
