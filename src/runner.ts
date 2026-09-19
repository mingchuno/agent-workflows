import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { type Configuration, configSchema, type Project } from "./config.js";
import {
  type AgentAdapter,
  BlockedError,
  type HostingAdapter,
  isBlockedError,
  type RunRecord,
  type Workspace,
} from "./domain.js";
import { defaultWorkflow, Operations } from "./operations.js";
import { createQueuedRun } from "./run-record.js";
import {
  assertProcessesStopped,
  CheckoutOwnership,
} from "./runtime/ownership.js";
import { createRedactor, runtimeLogger } from "./runtime/redaction.js";
import { Store } from "./store.js";
import { ExistingCheckout } from "./workspace.js";

export interface RunnerOptions {
  config: Configuration;
  databaseUrl: string;
  hosting: (project: Project) => HostingAdapter;
  agents: Record<string, AgentAdapter>;
  workflowVersion?: string;
  workspace?: Workspace;
  workflow?: (operations: Operations) => Promise<void>;
}
export class Runner {
  readonly store: Store;
  readonly config: Configuration;
  private readonly controllers = new Map<string, AbortController>();
  private readonly active = new Map<string, Promise<unknown>>();
  private readonly hosting = new Map<string, HostingAdapter>();
  private workflow!: (runId: string) => Promise<void>;
  private readonly ownership = new CheckoutOwnership();
  private stopping = false;
  private ownsRuntime = false;
  private tickBusy = false;
  private timer?: NodeJS.Timeout;
  private readonly lastPoll = new Map<string, number>();
  constructor(readonly options: RunnerOptions) {
    this.config = configSchema.parse(options.config);
    this.store = new Store(options.databaseUrl, this.config.id, this.redact);
  }
  private queue(id: string) {
    return `${this.config.id}:${id}`;
  }
  async start(): Promise<void> {
    if (DBOS.isInitialized())
      throw new Error("Only one Runner can own the DBOS runtime in a process");
    if (process.platform === "win32")
      throw new Error(
        "Phase 1 requires macOS or Linux process-group ownership",
      );
    const canonical = new Set<string>();
    const ids = new Set<string>();
    for (const project of this.config.projects) {
      project.checkout = await realpath(project.checkout);
      if (canonical.has(project.checkout) || ids.has(project.id))
        throw new Error("Duplicate project identity or canonical checkout");
      canonical.add(project.checkout);
      ids.add(project.id);
      this.hosting.set(project.id, this.options.hosting(project));
    }
    for (const hosting of this.hosting.values()) await hosting.preflight?.();
    await this.store.initialize();
    await this.store.acquire([...canonical], () => {
      this.stopping = true;
      for (const controller of this.controllers.values()) controller.abort();
    });
    await assertProcessesStopped(resolve(this.config.stateDirectory));
    for (const project of this.config.projects) {
      await this.ownership.acquire(
        project.checkout,
        resolve(this.config.stateDirectory),
      );
      await this.store.registerProject(project.id);
    }
    await mkdir(resolve(this.config.stateDirectory), {
      recursive: true,
      mode: 0o700,
    });
    this.workflow = DBOS.registerWorkflow(
      async (runId: string) => this.execute(runId),
      { name: `${this.config.id}-issue-workflow` },
    );
    DBOS.setConfig({
      name: `agent-workflows-${this.config.id}`,
      systemDatabaseUrl: this.options.databaseUrl,
      applicationVersion: `${this.config.id}-${this.options.workflowVersion ?? "phase1-v1"}`,
      executorID: this.config.id,
      listenQueues: this.config.projects.map((p) => this.queue(p.id)),
      logger: runtimeLogger(this.redact),
    });
    this.ownsRuntime = true;
    await DBOS.launch();
    for (const project of this.config.projects)
      await DBOS.registerQueue(this.queue(project.id), {
        globalConcurrency: 1,
        workerConcurrency: 1,
        minPollingIntervalMs: 100,
      });
    this.timer = setInterval(() => {
      void this.tick().catch((error) =>
        this.store.emit(null, "runner-error", {
          error: this.redact(String(error)),
        }),
      );
    }, 100);
    await this.tick();
  }
  private redact = (text: string): string =>
    createRedactor([
      this.options.databaseUrl,
      ...this.config.projects.map(
        (project) => process.env[project.hosting.tokenEnv] ?? "",
      ),
    ])(text);
  async poll(projectId?: string): Promise<void> {
    for (const project of this.config.projects.filter(
      (p) => !projectId || p.id === projectId,
    )) {
      const state = await this.store.project(project.id);
      if (state.paused || state.blocked || this.stopping) continue;
      const hosting = this.hosting.get(project.id)!;
      for (const issue of (await hosting.listIssues(project.labels)).sort(
        (a, b) => a.number - b.number,
      )) {
        const now = new Date().toISOString();
        const id = randomUUID();
        const run = createQueuedRun({
          id,
          projectId: project.id,
          checkout: project.checkout,
          taskKey: `${hosting.identity}:${issue.id}`,
          attempt: 1,
          issue,
          now,
          branchTemplate: project.branchTemplate,
        });
        await this.store.insertRun(run);
      }
    }
  }
  private async tick(): Promise<void> {
    if (this.tickBusy || this.stopping) return;
    this.tickBusy = true;
    try {
      await this.processCommands();
      await this.pollDueProjects();
      await this.dispatchRuns();
    } finally {
      this.tickBusy = false;
    }
  }
  private async processCommands(): Promise<void> {
    for (const request of (await this.store.commands()).filter(
      (c) => c.status === "pending",
    )) {
      try {
        if (request.kind === "pause") await this.pause(request.target);
        else if (request.kind === "resume") await this.resume(request.target);
        else if (request.kind === "stop") await this.stop(request.target);
        else if (request.kind === "retry")
          await this.retry(request.target, request.id);
        else throw new Error("Unknown command");
        await this.store.finishCommand(request.id);
      } catch (error) {
        await this.store.finishCommand(request.id, this.redact(String(error)));
      }
    }
  }
  private async pollDueProjects(): Promise<void> {
    for (const project of this.config.projects) {
      if (
        Date.now() - (this.lastPoll.get(project.id) ?? 0) >=
        project.pollIntervalMs
      ) {
        this.lastPoll.set(project.id, Date.now());
        try {
          await this.poll(project.id);
        } catch (error) {
          await this.store.emit(null, "poll-error", {
            projectId: project.id,
            error: this.redact(String(error)),
          });
        }
      }
    }
  }
  private async dispatchRuns(): Promise<void> {
    const runs = await this.store.runs();
    for (const project of this.config.projects) {
      const state = await this.store.project(project.id);
      if (state.paused || state.blocked) continue;
      const run = runs.find(
        (r) =>
          r.projectId === project.id &&
          (r.outcome === "queued" || r.outcome === "running"),
      );
      if (!run || this.active.has(run.id)) continue;
      const handle = await DBOS.startWorkflow(this.workflow, {
        workflowID: run.id,
        queueName: this.queue(project.id),
      })(run.id);
      const result = handle
        .getResult()
        .catch(async (error) => {
          await this.recordWorkflowFailure(run, error);
        })
        .finally(() => this.active.delete(run.id));
      this.active.set(run.id, result);
    }
  }
  private async recordWorkflowFailure(
    run: RunRecord,
    error: unknown,
  ): Promise<void> {
    const message = this.redact(String(error));
    await this.store.emit(run.id, "workflow-error", { error: message });
    const current = await this.store.run(run.id);
    if (["queued", "running"].includes(current.outcome)) {
      await this.store.patchRun(run.id, {
        outcome: "blocked",
        error: message,
      });
      await this.store.setProject(run.projectId, {
        blocked: `DBOS execution failed for ${run.id}; inspect recovery evidence`,
      });
    }
  }
  private async execute(runId: string): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    try {
      await this.executeOwned(runId, controller);
    } finally {
      this.controllers.delete(runId);
    }
  }
  private async executeOwned(
    runId: string,
    controller: AbortController,
  ): Promise<void> {
    const run = await DBOS.runStep(() => this.store.run(runId), {
      name: "load-run",
    });
    const project = this.config.projects.find((p) => p.id === run.projectId);
    if (!project) throw new Error("Project removed from configuration");
    const workspace = this.options.workspace ?? new ExistingCheckout();
    const operations = new Operations(runId, {
      store: this.store,
      project,
      workspace,
      hosting: this.hosting.get(project.id)!,
      agents: this.options.agents,
      artifacts: resolve(this.config.stateDirectory),
      signal: controller.signal,
      redact: this.redact,
    });
    try {
      while (true) {
        const state = await DBOS.runStep(() => this.store.project(project.id), {
          name: "start-gate",
        });
        if (state.blocked) throw new BlockedError(state.blocked);
        if (!state.paused) break;
        controller.signal.throwIfAborted();
        await DBOS.sleepms(200);
      }
      await (this.options.workflow ?? defaultWorkflow)(operations);
      await DBOS.runStep(
        async () => {
          const completed = await this.store.run(runId);
          if (["queued", "running"].includes(completed.outcome))
            throw new BlockedError(
              "Custom workflow returned without a terminal outcome",
            );
        },
        { name: "terminal-check" },
      );
    } catch (error) {
      await DBOS.runStep(
        async () => {
          let unsafe = false;
          try {
            await workspace.check(project);
          } catch {
            unsafe = true;
          }
          const outcome = controller.signal.aborted
            ? "cancelled"
            : isBlockedError(error)
              ? "blocked"
              : "failed";
          await this.store.patchRun(runId, {
            outcome,
            error: this.redact(String(error)),
          });
          if (unsafe || isBlockedError(error))
            await this.store.setProject(project.id, {
              blocked: `Run ${runId} requires recovery: ${this.redact(String(error))}`,
            });
        },
        { name: "record-failure", retriesAllowed: false },
      );
    } finally {
      this.controllers.delete(runId);
    }
  }
  async pause(projectId: string): Promise<void> {
    await this.store.project(projectId);
    await this.store.setProject(projectId, { paused: true });
  }
  async resume(projectId: string): Promise<void> {
    const state = await this.store.project(projectId);
    if (state.blocked) throw new Error(state.blocked);
    await this.store.setProject(projectId, { paused: false });
  }
  async stop(runId: string): Promise<void> {
    const run = await this.store.run(runId);
    const controller = this.controllers.get(runId);
    if (controller) {
      controller.abort();
      while (this.controllers.has(runId))
        await new Promise((resolve) => setTimeout(resolve, 20));
      return;
    }
    if (run.outcome === "queued") {
      await DBOS.cancelWorkflow(runId);
      await this.store.patchRun(runId, { outcome: "cancelled" });
      return;
    }
    if (run.outcome === "running")
      throw new BlockedError(
        "No local process ownership for this running workflow",
      );
  }
  async retry(runId: string, commandId?: string): Promise<string> {
    return this.store.admitRetry(runId, {
      commandId,
      checkSafety: async (previous) => {
        if (this.controllers.has(runId))
          throw new Error("Work has not stopped");
        const project = this.config.projects.find(
          (p) => p.id === previous.projectId,
        );
        if (!project) throw new Error("Project removed from configuration");
        await assertProcessesStopped(
          resolve(this.config.stateDirectory, runId),
        );
        await (this.options.workspace ?? new ExistingCheckout()).check(project);
        return {
          checkout: project.checkout,
          branchTemplate: project.branchTemplate,
        };
      },
    });
  }
  async shutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    for (const controller of this.controllers.values()) controller.abort();
    while (this.controllers.size || this.tickBusy)
      await new Promise((resolve) => setTimeout(resolve, 20));
    await Promise.all(this.active.values());
    if (this.ownsRuntime) {
      await DBOS.shutdown({
        deregister: true,
        workflowCompletionTimeoutMS: 5000,
      });
      this.ownsRuntime = false;
    }
    await this.ownership.release();
    await this.store.close();
  }
}
