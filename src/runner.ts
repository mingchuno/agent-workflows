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
import { executionFingerprint, verifyPublicationRecovery } from "./recovery.js";
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
  private readonly polling = new Map<string, Promise<void>>();
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
    await Promise.all(
      this.config.projects
        .filter((p) => !projectId || p.id === projectId)
        .map((project) => {
          const pending = this.polling.get(project.id);
          if (pending) return pending;
          if (this.stopping) return Promise.resolve();
          const polling = this.pollProject(project)
            .catch(async (error) => {
              await this.store.emit(null, "poll-error", {
                projectId: project.id,
                error: this.redact(String(error)),
              });
              throw error;
            })
            .finally(() => this.polling.delete(project.id));
          this.polling.set(project.id, polling);
          return polling;
        }),
    );
  }
  private async pollProject(project: Project): Promise<void> {
    const state = await this.store.project(project.id);
    if (state.paused || state.blocked || this.stopping) return;
    const hosting = this.hosting.get(project.id)!;
    for (const issue of (await hosting.listIssues(project.labels)).sort(
      (a, b) => a.number - b.number,
    )) {
      if (this.stopping) return;
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
  private async tick(): Promise<void> {
    if (this.tickBusy || this.stopping) return;
    this.tickBusy = true;
    try {
      await this.processCommands();
      this.pollDueProjects();
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
        else if (request.kind === "recover")
          await this.recover(request.target, request.id);
        else throw new Error("Unknown command");
        await this.store.finishCommand(request.id);
      } catch (error) {
        await this.store.finishCommand(request.id, this.redact(String(error)));
      }
    }
  }
  private pollDueProjects(): void {
    if (this.stopping) return;
    for (const project of this.config.projects) {
      if (
        !this.polling.has(project.id) &&
        Date.now() - (this.lastPoll.get(project.id) ?? 0) >=
          project.pollIntervalMs
      ) {
        this.lastPoll.set(project.id, Date.now());
        void this.poll(project.id).catch((error) =>
          runtimeLogger(this.redact).error(String(error)),
        );
      }
    }
  }
  private async dispatchRuns(): Promise<void> {
    if (this.stopping) return;
    const runs = await this.store.runs();
    for (const project of this.config.projects) {
      const state = await this.store.project(project.id);
      if (this.stopping) return;
      if (state.paused || state.blocked) continue;
      const run = runs.find(
        (r) =>
          r.projectId === project.id &&
          (r.outcome === "queued" || r.outcome === "running"),
      );
      if (!run || this.active.has(run.id)) continue;
      const handle = await this.dispatch(run, project);
      const result = handle
        .getResult()
        .catch(async (error) => {
          await this.recordWorkflowFailure(run, error);
        })
        .finally(() => this.active.delete(run.id));
      this.active.set(run.id, result);
    }
  }
  private async dispatch(run: RunRecord, project: Project) {
    const execution = run.executions?.at(-1);
    if (execution?.recoveryOf) {
      // Intent is committed first. On restart, adopt an existing fork instead of
      // creating it twice after an uncertain DBOS response.
      if (await DBOS.getWorkflowStatus(execution.id))
        return DBOS.retrieveWorkflow(execution.id);
      return DBOS.forkWorkflow(execution.recoveryOf, execution.startStep!, {
        newWorkflowID: execution.id,
        queueName: this.queue(project.id),
        applicationVersion: `${this.config.id}-${this.options.workflowVersion ?? "phase1-v1"}`,
      });
    }
    return DBOS.startWorkflow(this.workflow, {
      workflowID: run.id,
      queueName: this.queue(project.id),
    })(run.id);
  }
  private async recordWorkflowFailure(
    run: RunRecord,
    error: unknown,
  ): Promise<void> {
    const message = this.redact(String(error));
    const executionId = run.executions?.at(-1)?.id ?? run.id;
    await this.store.emit(run.id, "workflow-error", {
      executionId,
      error: message,
    });
    const current = await this.store.run(run.id);
    if ((current.executions?.at(-1)?.id ?? current.id) !== executionId) return;
    if (["queued", "running"].includes(current.outcome)) {
      await this.store.patchRun(run.id, {
        outcome: "blocked",
        error: message,
      });
      await this.store.blockProject(
        run.projectId,
        `DBOS execution failed for ${run.id}; inspect recovery evidence`,
      );
    }
  }
  private async execute(runId: string): Promise<void> {
    const controller = new AbortController();
    if (this.stopping) controller.abort();
    this.controllers.set(runId, controller);
    try {
      if (DBOS.workflowID !== runId && this.options.workflow)
        throw new BlockedError(
          "Publication recovery supports the default workflow only",
        );
      await this.executeOwned(runId, controller);
    } finally {
      this.controllers.delete(runId);
    }
  }
  private async executeOwned(
    runId: string,
    controller: AbortController,
  ): Promise<void> {
    const run = await DBOS.runStep(() => this.initializeExecution(runId), {
      name: "load-run",
    });
    const project = this.config.projects.find((p) => p.id === run.projectId);
    if (!project) throw new Error("Project removed from configuration");
    const workspace = this.options.workspace ?? new ExistingCheckout();
    let recoveryChecked = false;
    const operations = new Operations(runId, {
      store: this.store,
      project,
      workspace,
      hosting: this.hosting.get(project.id)!,
      agents: this.options.agents,
      artifacts: resolve(this.config.stateDirectory),
      signal: controller.signal,
      redact: this.redact,
      executionFingerprint: () =>
        executionFingerprint(
          project,
          this.options.workflowVersion ?? "phase1-v1",
          controller.signal,
        ),
      beforeStep: async () => {
        if (recoveryChecked) return;
        const current = await this.store.run(runId);
        const execution = current.executions?.at(-1);
        if (!execution?.recoveryOf) {
          await this.store.patchRun(runId, { outcome: "running" });
          recoveryChecked = true;
          return;
        }
        if (execution.id !== DBOS.workflowID)
          throw new BlockedError("Execution has been superseded");
        if (DBOS.stepID! < execution.startStep!)
          throw new BlockedError(
            "A reused checkpoint is missing; recovery refused",
          );
        // This runs inside the first non-replayed step, so copied start-gate
        // checkpoints cannot bypass today's pause or checkout checks.
        while (true) {
          controller.signal.throwIfAborted();
          const state = await this.store.project(project.id);
          if (state.blocked) throw new BlockedError(state.blocked);
          if (!state.paused) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        await this.store.patchRun(runId, { outcome: "running" });
        await this.checkRecoveryState(current, project, controller.signal);
        recoveryChecked = true;
      },
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
      controller.signal.throwIfAborted();
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
            await this.store.blockProject(
              project.id,
              `Run ${runId} requires recovery: ${this.redact(String(error))}`,
            );
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
  private async initializeExecution(runId: string): Promise<RunRecord> {
    const run = await this.store.run(runId);
    if (run.executions?.length) return run;
    const project = this.config.projects.find(
      (item) => item.id === run.projectId,
    );
    if (!project) throw new Error("Project removed from configuration");
    return this.store.patchRun(runId, {
      executions: [
        {
          id: run.id,
          // Capture inputs after prepare fetches and checks out the actual base.
          fingerprint: "",
          recoverySupported: !this.options.workflow,
          createdAt: run.createdAt,
          outcome: run.outcome,
          phase: run.phase,
        },
      ],
    });
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
      await DBOS.cancelWorkflow(run.executions?.at(-1)?.id ?? runId);
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
  async recover(runId: string, commandId?: string): Promise<string> {
    return this.store.admitRecovery(runId, {
      commandId,
      checkSafety: async (run) => {
        if (!this.ownsRuntime || this.stopping)
          throw new Error("Recovery requires an active runner");
        if (this.options.workflow)
          throw new Error(
            "Publication recovery currently supports the default workflow only",
          );
        if (this.controllers.has(runId))
          throw new Error("Work has not stopped");
        const project = this.config.projects.find(
          (item) => item.id === run.projectId,
        );
        if (!project) throw new Error("Project removed from configuration");
        const execution = run.executions!.at(-1)!;
        const status = await DBOS.getWorkflowStatus(execution.id);
        if (!status || !["SUCCESS", "ERROR"].includes(status.status))
          throw new Error("Source execution has not finished");
        if (
          status.applicationVersion !==
          `${this.config.id}-${this.options.workflowVersion ?? "phase1-v1"}`
        )
          throw new Error("Workflow version changed; use retry");
        const steps = await DBOS.listWorkflowSteps(execution.id);
        const failed = steps?.find(
          (step) => step.functionID === execution.failedStep,
        );
        if (!failed?.error || failed.name !== run.phase)
          throw new Error("Failed publication checkpoint is unavailable");
        const prefix = steps!.filter(
          (step) => step.functionID < failed.functionID,
        );
        if (
          prefix.length !== failed.functionID ||
          prefix.some(
            (step, index) => step.error || step.functionID !== index,
          ) ||
          !prefix.some((step) => step.name === "commit")
        )
          throw new Error("Completed publication checkpoints are unavailable");
        await this.checkRecoveryState(run, project);
        return prefix.map((step) => step.name);
      },
    });
  }
  private async checkRecoveryState(
    run: RunRecord,
    project: Project,
    signal?: AbortSignal,
  ): Promise<void> {
    await verifyPublicationRecovery(run, {
      project,
      signal,
      store: this.store,
      workspace: this.options.workspace ?? new ExistingCheckout(),
      hosting: this.hosting.get(project.id)!,
      stateDirectory: this.config.stateDirectory,
      workflowVersion: this.options.workflowVersion ?? "phase1-v1",
    });
  }
  async shutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    for (const controller of this.controllers.values()) controller.abort();
    while (this.controllers.size || this.tickBusy)
      await new Promise((resolve) => setTimeout(resolve, 20));
    await Promise.all(this.active.values());
    await Promise.allSettled(this.polling.values());
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
