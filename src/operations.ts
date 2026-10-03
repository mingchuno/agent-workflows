import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { contributingProviders, finalizeCommitMessage } from "./attribution.js";
import { type Project, resolveProfile, type Stage } from "./config.js";
import {
  type AgentAdapter,
  BlockedError,
  type HostingAdapter,
  isBlockedError,
  publicationSchema,
  type RunRecord,
  reviewSchema,
  type ValidationResult,
  type Workspace,
} from "./domain.js";
import { type InvocationTask, invokeStage } from "./invocation.js";
import { defaultStagePrompts } from "./prompts.js";
import { publicationSteps } from "./recovery.js";
import { command } from "./runtime/process.js";
import type { Store } from "./store.js";
import { selectValidation } from "./validation-selection.js";

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
      if (
        !issue.open ||
        !project.labels.every((label) => issue.labels.includes(label))
      )
        return false;
      const { profile } = selectValidation(run.issue.body, project);
      await this.dependencies.store.patchRun(run.id, {
        validationProfile: profile,
      });
      return true;
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
      }),
    );
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
      const { project, workspace, signal, redact } = this.dependencies;
      if (!run.snapshot)
        throw new BlockedError("Missing implementation snapshot");
      await workspace.verify(project, run.snapshot);
      if (!run.snapshot.paths.length) return false;
      const validation: ValidationResult[] = [];
      const directory = join(this.dependencies.artifacts, run.id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const checks = selectValidation(run.issue.body, project).commands;
      for (const [index, check] of checks.entries()) {
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
          await this.recordValidation(run.id, validation, {
            ...check,
            exitCode: -1,
            log,
            startedAt,
            finishedAt: new Date().toISOString(),
          });
          throw error;
        }
        await appendFile(log, redact(captured), { mode: 0o600 });
        await this.recordValidation(run.id, validation, {
          ...check,
          exitCode: result.exitCode,
          log,
          startedAt,
          finishedAt: new Date().toISOString(),
        });
        if (result.exitCode !== 0)
          throw new Error(
            `Validation failed: ${check.command} (exit ${result.exitCode})`,
          );
      }
      await workspace.verify(project, run.snapshot);
      return true;
    });
  }
  private async recordValidation(
    runId: string,
    validation: ValidationResult[],
    result: ValidationResult,
  ): Promise<void> {
    validation.push(result);
    await this.dependencies.store.patchRun(runId, { validation });
  }
  private async publicationSession(): Promise<string | undefined> {
    const { project, store } = this.dependencies;
    if (project.stages.publication.useNewSession) return undefined;
    return this.step("publication-session", async () => {
      const implementation = (await store.invocations(this.runId))
        .filter(
          (record) =>
            record.step === "implementation" && record.outcome === "completed",
        )
        .at(-1);
      const provider = resolveProfile(
        project.agent,
        project.stages.publication.profile,
      ).provider;
      if (
        !implementation?.sessionId ||
        implementation.sessionState !== "available"
      )
        throw new BlockedError(
          "Implementation session unavailable; set stages.publication.useNewSession=true for a fresh session",
        );
      if (implementation.provider !== provider)
        throw new BlockedError(
          "Publication cannot resume a different provider; set stages.publication.useNewSession=true",
        );
      return implementation.sessionId;
    });
  }
  async writePublication(): Promise<void> {
    const resumeSessionId = await this.publicationSession();
    const output = await this.invoke(
      "publication",
      this.dependencies.project.stages.publication,
      {
        defaultPrompt: defaultStagePrompts.publication,
        preserveCheckout: true,
        resumeSessionId,
        outputContract: publicationSchema,
        context: (run) =>
          `Checkout: ${this.dependencies.project.checkout}\nBase revision: ${run.base}\nValidated snapshot: ${run.snapshot?.fingerprint}\nChanged paths: ${JSON.stringify(run.snapshot?.paths)}\nInspect staged and unstaged changes with git diff and git diff --cached. Use git ls-files --others --exclude-standard and file tools for untracked changes. Inspect by path and search as needed; do not assume git diff includes untracked files.\nIssue: ${JSON.stringify(run.issue)}\nValidation: ${JSON.stringify(run.validation ?? [])}`,
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
    const output = await this.invoke(
      "review",
      this.dependencies.project.stages.review,
      {
        defaultPrompt: defaultStagePrompts.review,
        preserveCheckout: true,
        outputContract: reviewSchema,
        context: (run) => {
          if (!run.base || !run.head)
            throw new BlockedError("Missing published revisions");
          return `Checkout: ${this.dependencies.project.checkout}\nBase revision: ${run.base}\nPublished revision: ${run.head}\nInspect the exact revision pair with git diff ${run.base} ${run.head}, starting with --stat or --name-status and reading selected paths. Use git show and source search for context.\nIssue: ${JSON.stringify(run.issue)}\nValidation: ${JSON.stringify(run.validation ?? [])}\nSet complete=false with limitations if required changes or source cannot be inspected. Never report an incomplete review as clean. Use null for finding path/line where no valid added-line location exists.`;
        },
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
          "Incomplete review; use retry for a fresh inspection",
        );
      if ((await hosting.head(run.change)) !== run.reviewHead)
        throw new BlockedError("Review stale: remote head changed");
      const paths = [
        ...new Set(
          run.review.findings
            .filter((finding) => finding.path && finding.line)
            .map((finding) => finding.path!),
        ),
      ];
      const diff = paths.length
        ? (
            await command(
              "git",
              [
                "--literal-pathspecs",
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--unified=0",
                run.base,
                run.reviewHead,
                "--",
                ...paths,
              ],
              { cwd: project.checkout, signal: this.dependencies.signal },
            )
          ).stdout
        : "";
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
