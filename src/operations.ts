import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { contributingProviders, finalizeCommitMessage } from "./attribution.js";
import type { Project, Stage } from "./config.js";
import {
  type AgentAdapter,
  BlockedError,
  type HostingAdapter,
  isBlockedError,
  publicationSchema,
  type RunRecord,
  reviewSchema,
  type Snapshot,
  type Workspace,
} from "./domain.js";
import {
  type ChangeEvidence,
  captureEvidence,
  evidenceContext,
} from "./evidence.js";
import { type InvocationTask, invokeStage } from "./invocation.js";
import { defaultStagePrompts } from "./prompts.js";
import { publicationSteps } from "./recovery.js";
import { command } from "./runtime/process.js";
import type { Store } from "./store.js";

export type { InvocationTask } from "./invocation.js";

const maxStepAttempts = 3;

export interface OperationDependencies {
  promptBaseDirectory?: string;
  store: Store;
  project: Project;
  workspace: Workspace;
  hosting: HostingAdapter;
  agents: Record<string, AgentAdapter>;
  artifacts: string;
  signal: AbortSignal;
  redact: (text: string) => string;
  beforeStep?: () => Promise<void>;
  executionFingerprint?: () => Promise<string>;
}
/** Reusable durable coding operations. Call from a registered DBOS workflow. */
export class Operations {
  constructor(
    readonly runId: string,
    readonly dependencies: OperationDependencies,
  ) {}
  async step<T>(
    name: string,
    operation: (run: RunRecord) => Promise<T>,
  ): Promise<T> {
    return DBOS.runStep(
      async () => {
        const { store, signal } = this.dependencies;
        signal.throwIfAborted();
        await this.dependencies.beforeStep?.();
        const run = await store.run(this.runId);
        await store.patchRun(this.runId, { phase: name });
        await store.emit(this.runId, "step", {
          name,
          executionId: DBOS.workflowID,
          stepId: DBOS.stepID,
          attempt: DBOS.stepStatus?.currentAttempt ?? 1,
          status: "running",
        });
        try {
          if (run.checkout !== this.dependencies.project.checkout)
            throw new BlockedError(
              "Configured checkout differs from the recorded run checkout",
            );
          const result = await operation(run);
          await store.emit(this.runId, "step", {
            name,
            executionId: DBOS.workflowID,
            stepId: DBOS.stepID,
            attempt: DBOS.stepStatus?.currentAttempt ?? 1,
            status: "completed",
          });
          return result;
        } catch (error) {
          if (
            !publicationSteps.includes(name) ||
            isBlockedError(error) ||
            DBOS.stepStatus?.currentAttempt === maxStepAttempts
          )
            await store.patchRun(this.runId, { failedStep: DBOS.stepID! });
          await store.emit(this.runId, "step", {
            name,
            executionId: DBOS.workflowID,
            stepId: DBOS.stepID,
            attempt: DBOS.stepStatus?.currentAttempt ?? 1,
            status: "failed",
            error: this.dependencies.redact(String(error)),
          });
          const message = this.dependencies.redact(
            error instanceof Error ? error.message : String(error),
          );
          throw isBlockedError(error)
            ? new BlockedError(message)
            : new Error(message);
        }
      },
      {
        name,
        retriesAllowed: publicationSteps.includes(name),
        maxAttempts: maxStepAttempts,
        intervalSeconds: 0.2,
        backoffRate: 2,
        shouldRetry: (error) => !isBlockedError(error),
      },
    );
  }
  async eligible(): Promise<boolean> {
    return this.step("eligibility", async (run) => {
      const { hosting, project } = this.dependencies;
      const issue = await hosting.getIssue(run.issue.number);
      return (
        issue.open &&
        project.labels.every((label) => issue.labels.includes(label))
      );
    });
  }
  async prepare(): Promise<void> {
    await this.step("prepare", async (run) => {
      const { workspace, project, store } = this.dependencies;
      const snapshot = await workspace.prepare(
        project,
        run.branch,
        this.dependencies.signal,
      );
      const execution = run.executions?.at(-1);
      if (
        execution?.recoverySupported &&
        this.dependencies.executionFingerprint
      )
        execution.fingerprint = await this.dependencies.executionFingerprint();
      await store.patchRun(run.id, {
        base: snapshot.head,
        snapshot,
        outcome: "running",
        executions: run.executions,
      });
    });
  }
  async invoke(
    name: string,
    stage: Stage,
    task: InvocationTask,
  ): Promise<string> {
    return this.step(name, (run) =>
      invokeStage({
        run,
        name,
        stage,
        task,
        stepId: DBOS.stepID!,
        dependencies: this.dependencies,
        saveImplementationSnapshot: (runId, expected, provider) =>
          this.saveImplementationSnapshot(runId, expected, provider),
      }),
    );
  }

  private async saveImplementationSnapshot(
    runId: string,
    expected: Snapshot,
    provider: string,
  ): Promise<void> {
    const { workspace, project, store } = this.dependencies;
    const snapshot = await workspace.inspect(project);
    if (snapshot.head !== expected.head || snapshot.branch !== expected.branch)
      throw new BlockedError("Agent changed branch or committed unexpectedly");
    const run = await store.run(runId);
    await store.patchRun(runId, {
      snapshot,
      contributionCandidates:
        snapshot.fingerprint === expected.fingerprint
          ? run.contributionCandidates
          : [
              ...(run.contributionCandidates ?? []),
              {
                provider,
                beforeFiles: expected.files,
                afterFiles: snapshot.files,
              },
            ],
    });
  }
  async implement(): Promise<void> {
    await this.invoke(
      "implementation",
      this.dependencies.project.stages.implementation,
      {
        defaultPrompt: defaultStagePrompts.implementation,
        context: (run) => `Issue: ${JSON.stringify(run.issue)}`,
      },
    );
  }

  async validate(): Promise<boolean> {
    return this.step("validation", async (run) => {
      const { project, workspace, store, signal, redact } = this.dependencies;
      if (!run.snapshot)
        throw new BlockedError("Missing implementation snapshot");
      await workspace.verify(project, run.snapshot);
      if (!run.snapshot.paths.length) return false;
      const validation = [];
      const directory = join(this.dependencies.artifacts, run.id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      for (const [index, check] of project.validation.entries()) {
        const startedAt = new Date().toISOString();
        const log = join(directory, `validation-${index}.log`);
        let captured = "";
        let result: Awaited<ReturnType<typeof command>>;
        try {
          result = await command(check.command, check.args, {
            cwd: project.checkout,
            signal,
            processFile: log + ".process.json",
            timeoutMs: check.timeoutMs,
            allowFailure: true,
            onOutput: (chunk) => {
              captured += chunk;
            },
          });
        } catch (error) {
          await appendFile(log, redact(captured + "\n" + String(error)), {
            mode: 0o600,
          });
          validation.push({
            ...check,
            exitCode: -1,
            log,
            startedAt,
            finishedAt: new Date().toISOString(),
          });
          await store.patchRun(run.id, { validation });
          throw error;
        }
        await appendFile(log, redact(captured), { mode: 0o600 });
        validation.push({
          ...check,
          exitCode: result.exitCode,
          log,
          startedAt,
          finishedAt: new Date().toISOString(),
        });
        await store.patchRun(run.id, { validation });
        if (result.exitCode !== 0)
          throw new Error(
            `Validation failed: ${check.command} (exit ${result.exitCode})`,
          );
      }
      await workspace.verify(project, run.snapshot);
      return true;
    });
  }
  private async prepareEvidence(
    name: string,
    published = false,
  ): Promise<ChangeEvidence> {
    return this.step(name, async (run) => {
      const { project, workspace, artifacts, signal } = this.dependencies;
      if (!run.snapshot) throw new BlockedError("Missing workspace snapshot");
      if (published && (!run.base || !run.head))
        throw new BlockedError("Missing published revisions");
      await workspace.verify(project, run.snapshot);
      const evidence = await captureEvidence({
        project,
        snapshot: run.snapshot,
        directory: join(artifacts, run.id, `${name}-${randomUUID()}`),
        signal,
        revisions: published ? { base: run.base!, head: run.head! } : undefined,
      });
      await workspace.verify(project, run.snapshot);
      return evidence;
    });
  }
  async writePublication(): Promise<void> {
    const evidence = await this.prepareEvidence("publication-input");
    const output = await this.invoke(
      "publication",
      this.dependencies.project.stages.publication,
      {
        defaultPrompt: defaultStagePrompts.publication,
        readOnly: true,
        outputContract: publicationSchema,
        evidence,
        context: (run) =>
          `${evidenceContext(evidence)}\nIssue: ${JSON.stringify(run.issue)}\nValidation: ${JSON.stringify(run.validation ?? [])}`,
      },
    );
    await this.step("publication-content", async (run) => {
      if (!run.snapshot) throw new Error("Missing publication snapshot");
      const providers = contributingProviders(
        run.contributionCandidates ?? [],
        run.snapshot,
      );
      await this.dependencies.store.patchRun(run.id, {
        publication: finalizeCommitMessage(
          publicationSchema.parse(JSON.parse(output)),
          this.dependencies.project,
          providers,
          run.id,
        ),
        contributingProviders: providers,
      });
    });
  }
  async commit(): Promise<void> {
    await this.step("commit", async (run) => {
      if (!run.snapshot || !run.publication)
        throw new Error("Missing validated publication input");
      if (run.head) {
        await this.dependencies.workspace.verify(
          this.dependencies.project,
          run.snapshot,
        );
        return;
      }
      const head = await this.dependencies.workspace.commit(
        this.dependencies.project,
        run.snapshot,
        run.publication,
        run.id,
        this.dependencies.signal,
      );
      const snapshot = await this.dependencies.workspace.inspect(
        this.dependencies.project,
      );
      await this.dependencies.store.patchRun(run.id, { head, snapshot });
    });
  }
  async push(): Promise<void> {
    await this.step("push", async (run) => {
      if (!run.head) throw new Error("Missing commit");
      await this.dependencies.workspace.push(
        this.dependencies.project,
        run.branch,
        run.head,
        this.dependencies.signal,
      );
    });
  }
  async publish(): Promise<void> {
    await this.step("change-request", async (run) => {
      const { hosting, project, store } = this.dependencies;
      if (!run.head || !run.publication) throw new Error("Missing publication");
      const change =
        (await hosting.findChange(run.branch)) ??
        (await hosting.createChange({
          branch: run.branch,
          base: project.baseBranch,
          head: run.head,
          issue: run.issue,
          publication: run.publication,
          runId: run.id,
        }));
      if (change.head !== run.head)
        throw new BlockedError("Existing change request has a different head");
      await store.patchRun(run.id, { change });
    });
  }
  async review(): Promise<void> {
    const evidence = await this.prepareEvidence("review-input", true);
    const output = await this.invoke(
      "review",
      this.dependencies.project.stages.review,
      {
        defaultPrompt: defaultStagePrompts.review,
        readOnly: true,
        outputContract: reviewSchema,
        evidence,
        context: (run) =>
          `${evidenceContext(evidence)}\nIssue: ${JSON.stringify(run.issue)}\nValidation: ${JSON.stringify(run.validation ?? [])}\nSet complete=false with limitations if any required evidence cannot be inspected. Never report an incomplete review as clean. Use null for finding path/line where no valid added-line location exists.`,
      },
    );
    await this.step("review-content", async (run) => {
      const review = reviewSchema.parse(JSON.parse(output));
      await this.dependencies.store.patchRun(run.id, {
        review,
        reviewHead: run.head,
      });
      if (!review.complete)
        throw new BlockedError(
          "Incomplete review; partial findings and limitations retained locally",
        );
    });
  }
  async publishReview(): Promise<void> {
    await this.step("review-publication", async (run) => {
      const { hosting, project } = this.dependencies;
      if (!run.change || !run.review || !run.reviewHead || !run.base)
        throw new Error("Missing review");
      if (run.review.complete !== true)
        throw new BlockedError(
          "Incomplete or historical review; use retry for a fresh inspection",
        );
      if ((await hosting.head(run.change)) !== run.reviewHead)
        throw new BlockedError("Review stale: remote head changed");
      const diff = (
        await command(
          "git",
          ["diff", "--unified=0", run.base, run.reviewHead],
          { cwd: project.checkout },
        )
      ).stdout;
      await hosting.publishReview({
        change: run.change,
        head: run.reviewHead,
        review: run.review,
        runId: run.id,
        diff,
      });
    });
  }
  async complete(outcome: RunRecord["outcome"] = "completed"): Promise<void> {
    await this.step("completion", async (run) => {
      await this.dependencies.workspace.release(this.dependencies.project);
      await this.dependencies.store.patchRun(run.id, { outcome });
    });
  }
}
export async function defaultWorkflow(operations: Operations): Promise<void> {
  if (!(await operations.eligible())) {
    await operations.step("ineligible", async (run) => {
      await operations.dependencies.store.patchRun(run.id, {
        outcome: "ineligible",
      });
    });
    return;
  }
  await operations.prepare();
  await operations.implement();
  if (!(await operations.validate())) {
    await operations.complete("no-change");
    return;
  }
  await operations.writePublication();
  await operations.commit();
  await operations.push();
  await operations.publish();
  await operations.review();
  await operations.publishReview();
  await operations.complete();
}
