import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { contributingProviders, finalizeCommitMessage } from "./attribution.js";
import { type Project, resolveProfile, type Stage } from "./config.js";
import {
  type AgentAdapter,
  BlockedError,
  type HostingAdapter,
  implementationSchema,
  isBlockedError,
  isStaleReviewError,
  publicationSchema,
  type ReviewRequest,
  type RunRecord,
  reviewSchema,
  StaleReviewError,
  type ValidationResult,
  type Workspace,
} from "./domain.js";
import { type InvocationTask, invokeStage } from "./invocation.js";
import { defaultStagePrompts } from "./prompts.js";
import { withDeliveryEvidence } from "./publication-evidence.js";
import { publicationSteps } from "./recovery.js";
import {
  alreadyReviewed,
  reviewEligible,
  sameReviewRevision,
} from "./review-intake.js";
import { prepareReviewPositions } from "./review-positions.js";
import { CommandTimeoutError, command } from "./runtime/process.js";
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
            isStaleReviewError(error) ||
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
          if (isStaleReviewError(error))
            throw run.subject.kind === "change-request"
              ? new StaleReviewError()
              : new BlockedError(message);
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
        shouldRetry: (error) =>
          !isBlockedError(error) && !isStaleReviewError(error),
      },
    );
  }
  async eligible(): Promise<boolean> {
    return this.step("eligibility", async (run) => {
      const { hosting, project } = this.dependencies;
      if (
        run.subject.kind !== "issue" ||
        !project.workflows.implementation.enabled
      )
        return false;
      const issue = await hosting.getIssue(run.subject.number);
      if (
        !issue.open ||
        !project.workflows.implementation.labels.every((label) =>
          issue.labels.includes(label),
        )
      )
        return false;
      const { profile } = selectValidation(run.subject.body, project);
      await this.dependencies.store.patchRun(run.id, {
        validationProfile: profile,
      });
      return true;
    });
  }
  async reviewEligible(): Promise<boolean> {
    return this.step("review-eligibility", async (run) => {
      if (run.subject.kind !== "change-request")
        throw new Error("Review workflow requires a change request");
      const { project, hosting, store } = this.dependencies;
      const current = await hosting.getChange(run.subject.number);
      if (
        !reviewEligible(current, project) ||
        alreadyReviewed(await store.runs(), project, current)
      )
        return false;
      if (
        current.id !== run.subject.id ||
        current.number !== run.subject.number ||
        current.url !== run.subject.url
      )
        throw new StaleReviewError();
      if (!sameReviewRevision(run.subject, current)) {
        // Before inspection, a one-shot review follows the latest eligible revision.
        if (project.workflows.review.rereviewOnPush || run.review)
          throw new StaleReviewError();
        await store.patchRun(run.id, {
          subject: { ...current, kind: "change-request" },
          change: current.change,
        });
      }
      return true;
    });
  }
  private async assertReviewFresh(request: ReviewRequest): Promise<void> {
    const { hosting, project } = this.dependencies;
    const current = await hosting.getChange(request.number);
    if (
      !reviewEligible(current, project) ||
      !sameReviewRevision(request, current)
    )
      throw new StaleReviewError();
  }
  async prepareReview(): Promise<void> {
    await this.step("review-prepare", async (run) => {
      if (run.subject.kind !== "change-request")
        throw new Error("Missing review request");
      const { workspace, project, store } = this.dependencies;
      const request = run.subject;
      const assertFresh = async () => {
        this.dependencies.signal.throwIfAborted();
        await this.assertReviewFresh(request);
      };
      await assertFresh();
      let snapshot: Awaited<ReturnType<Workspace["prepareReview"]>>;
      try {
        snapshot = await workspace.prepareReview(
          project,
          run.subject,
          this.dependencies.signal,
        );
      } catch (error) {
        await assertFresh();
        throw error;
      }
      await assertFresh();
      await store.patchRun(run.id, {
        base: run.subject.base,
        head: run.subject.change.head,
        branch: snapshot.branch,
        snapshot,
        outcome: "running",
      });
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
        executionId: DBOS.workflowID!,
        dependencies: this.dependencies,
      }),
    );
  }
  async implement(): Promise<void> {
    const output = await this.invoke(
      "implementation",
      this.dependencies.project.stages.implementation,
      {
        defaultPrompt: defaultStagePrompts.implementation,
        context: (run) => `Issue: ${JSON.stringify(run.subject)}`,
        outputContract: implementationSchema,
      },
    );
    await this.recordAgentReport(output);
  }

  private async recordAgentReport(output: string): Promise<void> {
    await this.step("implementation-report", async (run) => {
      await this.dependencies.store.patchRun(run.id, {
        agentReport: implementationSchema.parse(JSON.parse(output)),
      });
    });
  }
  async fix(): Promise<void> {
    const session = await this.step("fix-session", async () => {
      const invocation = (await this.dependencies.store.invocations(this.runId))
        .filter(
          (item) =>
            ["implementation", "fix"].includes(item.step) &&
            item.outcome === "completed",
        )
        .at(-1);
      if (!invocation?.sessionId || invocation.sessionState !== "available")
        throw new BlockedError("Implementation session unavailable for repair");
      return invocation.sessionId;
    });
    const output = await this.invoke(
      "fix",
      this.dependencies.project.stages.implementation,
      {
        defaultPrompt: defaultStagePrompts.implementation,
        resumeSessionId: session,
        outputContract: implementationSchema,
        context: (
          run,
        ) => `Repair the blocking review findings and failed configured checks.
Issue: ${JSON.stringify(run.subject)}
Review: ${JSON.stringify(run.review)}
Configured checks: ${JSON.stringify(run.validation)}
Blocking threshold: ${this.dependencies.project.workflows.implementation.review.blockAtOrAbove}`,
      },
    );
    await this.recordAgentReport(output);
  }
  async validate(): Promise<boolean> {
    return this.step("validation", async (run) => {
      const { project, workspace, signal, redact } = this.dependencies;
      if (!run.snapshot)
        throw new BlockedError("Missing implementation snapshot");
      await workspace.verify(project, run.snapshot);
      if (!run.snapshot.paths.length) return false;
      const validation: ValidationResult[] = [];
      await this.dependencies.store.patchRun(run.id, {
        validation,
        validationStatus: undefined,
      });
      const directory = join(this.dependencies.artifacts, run.id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const checks = selectValidation(run.subject.body, project).commands;
      for (const [index, check] of checks.entries()) {
        const startedAt = new Date().toISOString();
        const log = join(directory, `validation-${DBOS.stepID}-${index}.log`);
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
          if (signal.aborted || !(error instanceof CommandTimeoutError))
            throw error;
          await this.dependencies.store.patchRun(run.id, {
            validationStatus: "failed",
          });
          await workspace.verify(project, run.snapshot);
          return true;
        }
        await appendFile(log, redact(captured), { mode: 0o600 });
        await this.recordValidation(run.id, validation, {
          ...check,
          exitCode: result.exitCode,
          log,
          startedAt,
          finishedAt: new Date().toISOString(),
        });
        if (result.exitCode !== 0) break;
      }
      await this.dependencies.store.patchRun(run.id, {
        validationStatus: !checks.length
          ? "skipped"
          : validation.some((check) => check.exitCode !== 0)
            ? "failed"
            : "passed",
      });
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
          `Checkout: ${this.dependencies.project.checkout}\nBase revision: ${run.base}\nValidated snapshot: ${run.snapshot?.fingerprint}\nChanged paths: ${JSON.stringify(run.snapshot?.paths)}\nInspect staged and unstaged changes with git diff and git diff --cached. Use git ls-files --others --exclude-standard and file tools for untracked changes. Inspect by path and search as needed; do not assume git diff includes untracked files.\nIssue: ${JSON.stringify(run.subject)}\nValidation: ${JSON.stringify(run.validation ?? [])}\nAgent-reported validation (not workflow-executed): ${JSON.stringify(run.agentReport)}\nFinal review: ${JSON.stringify(run.review)}\nReadiness: ${JSON.stringify(run.readiness)}`,
      },
    );
    await this.step("publication-content", async (run) => {
      if (!run.snapshot) throw new Error("Missing publication snapshot");
      const providers = contributingProviders(
        run.contributionCandidates ?? [],
        run.snapshot,
      );
      const publication = withDeliveryEvidence(
        publicationSchema.parse(JSON.parse(output)),
        run,
      );
      await this.dependencies.store.patchRun(run.id, {
        publication: finalizeCommitMessage(
          publication,
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
      if (snapshot.paths.length || snapshot.branch !== run.snapshot.branch)
        throw new BlockedError("Commit changed checkout content");
      // Reconciliation compares the final commit with the reviewed precommit snapshot.
      const reconciled = await this.dependencies.workspace.commit(
        this.dependencies.project,
        run.snapshot,
        run.publication,
        run.id,
        this.dependencies.signal,
      );
      if (reconciled !== head)
        throw new BlockedError("Commit revision changed");
      await this.dependencies.store.patchRun(run.id, {
        head,
        snapshot,
        reviewHead: head,
      });
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
          issue: run.subject,
          publication: run.publication,
          runId: run.id,
          draft: run.readiness?.draft ?? true,
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
          if (
            !run.base ||
            !run.snapshot ||
            (run.subject.kind === "change-request" && !run.head)
          )
            throw new BlockedError("Missing review target");
          if (run.subject.kind === "issue")
            return `Local changes
Checkout: ${this.dependencies.project.checkout}
Base revision: ${run.base}
Snapshot: ${run.snapshot.fingerprint}
Changed paths: ${JSON.stringify(run.snapshot.paths)}
Inspect git diff ${run.base}, git diff --cached, and untracked files from git ls-files --others --exclude-standard. Read untracked contents separately.
Issue: ${JSON.stringify(run.subject)}
Workflow-executed validation: ${JSON.stringify(run.validation ?? [])}
Agent-reported validation: ${JSON.stringify(run.agentReport)}
Set complete=false and explain limitations when inspection is incomplete. Assign P0/P1/P2/P3 priorities to findings.`;
          return `Checkout: ${this.dependencies.project.checkout}\nBase revision: ${run.base}\nPublished revision: ${run.head}\nInspect the exact revision pair with git diff ${run.base} ${run.head}, starting with --stat or --name-status and reading selected paths. Use git show and source search for context.\nChange request: ${JSON.stringify(run.subject)}\nValidation: ${JSON.stringify(run.validation ?? [])}\nSet complete=false with limitations if required changes or source cannot be inspected. Never report an incomplete review as clean. Use null for finding path/line where no valid added-line location exists.`;
        },
      },
    );
    await this.step("review-content", async (run) => {
      const review = reviewSchema.parse(JSON.parse(output));
      await this.dependencies.store.patchRun(run.id, {
        review,
        reviewHead: run.head,
      });
      if (!review.complete && run.subject.kind === "change-request")
        throw new BlockedError(
          "Incomplete review; partial findings and limitations retained locally",
        );
    });
  }
  async recordReadiness(): Promise<{ draft: boolean; complete: boolean }> {
    return this.step("review-readiness", async (run) => {
      if (!run.review || !run.snapshot)
        throw new BlockedError("Missing local review evidence");
      const threshold =
        this.dependencies.project.workflows.implementation.review
          .blockAtOrAbove;
      const reasons: string[] = [];
      if (!run.review.complete) reasons.push("Review incomplete");
      if (
        run.review.findings.some(
          (finding) => (finding.priority ?? "P2") <= threshold,
        )
      )
        reasons.push("Blocking review findings remain");
      if (run.validation?.some((check) => check.exitCode !== 0))
        reasons.push("Configured validation failed");
      const readiness = { draft: reasons.length > 0, reasons };
      await this.dependencies.store.patchRun(run.id, {
        readiness,
        reviewRounds: [
          ...(run.reviewRounds ?? []),
          {
            round: run.reviewRounds?.length ?? 0,
            snapshot: run.snapshot,
            validation: run.validation ?? [],
            validationStatus: run.validationStatus ?? "skipped",
            agentReport: run.agentReport,
            review: run.review,
            readiness,
          },
        ],
      });
      return { draft: readiness.draft, complete: run.review.complete };
    });
  }
  async publishReview(): Promise<void> {
    await this.step("review-publication", async (run) => {
      const { hosting, project } = this.dependencies;
      const publicationId =
        run.subject.kind === "change-request"
          ? run.reviewPublicationId
          : run.id;
      if (!publicationId)
        throw new BlockedError(
          "Review run is missing its publication identity",
        );
      if (!run.change || !run.review || !run.reviewHead || !run.base)
        throw new Error("Missing review");
      if (run.review.complete !== true && run.subject.kind === "change-request")
        throw new BlockedError(
          "Incomplete review; use retry for a fresh inspection",
        );
      if (run.subject.kind === "change-request") {
        await this.assertReviewFresh(run.subject);
      }
      if ((await hosting.head(run.change)) !== run.reviewHead)
        throw run.subject.kind === "change-request"
          ? new StaleReviewError()
          : new BlockedError("Review stale: remote head changed");
      const positions = !run.review.complete
        ? {
            inline: [],
            summaryFindings: run.review.findings.map((finding) => finding.body),
          }
        : await prepareReviewPositions({
            checkout: project.checkout,
            base: run.base,
            head: run.reviewHead,
            review: run.review,
            signal: this.dependencies.signal,
          });
      await hosting.publishReview({
        change: run.change,
        head: run.reviewHead,
        review: run.review,
        runId: publicationId,
        positions,
        ...(run.subject.kind === "change-request"
          ? {
              reviewTarget: {
                request: run.subject,
                labels: project.workflows.review.labels,
              },
            }
          : {}),
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
  await operations.review();
  let readiness = await operations.recordReadiness();
  for (
    let round = 0;
    readiness.draft &&
    readiness.complete &&
    round <
      operations.dependencies.project.workflows.implementation.review
        .maxFixRounds;
    round++
  ) {
    await operations.fix();
    if (!(await operations.validate())) {
      await operations.complete("no-change");
      return;
    }
    await operations.review();
    readiness = await operations.recordReadiness();
  }
  await operations.writePublication();
  await operations.commit();
  await operations.push();
  await operations.publish();
  await operations.publishReview();
  await operations.complete();
}

export async function reviewWorkflow(operations: Operations): Promise<void> {
  if (!(await operations.reviewEligible())) {
    await operations.complete("ineligible");
    return;
  }
  await operations.prepareReview();
  const retained = await operations.step(
    "review-reuse",
    async (run) => run.review?.complete === true && run.reviewHead === run.head,
  );
  if (!retained) await operations.review();
  await operations.publishReview();
  await operations.complete();
}
