import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DBOS } from "@dbos-inc/dbos-sdk";
import type { Project, Stage } from "./config.js";
import { resolveProfile } from "./config.js";
import {
  type AgentAdapter,
  BlockedError,
  type HostingAdapter,
  isBlockedError,
  publicationSchema,
  type RunRecord,
  reviewSchema,
  type Workspace,
} from "./domain.js";
import { command } from "./runtime/process.js";
import type { InvocationRecord, Store } from "./store.js";

export interface OperationDependencies {
  store: Store;
  project: Project;
  workspace: Workspace;
  hosting: HostingAdapter;
  agents: Record<string, AgentAdapter>;
  artifacts: string;
  signal: AbortSignal;
  redact: (text: string) => string;
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
        const run = await store.run(this.runId);
        await store.patchRun(this.runId, { phase: name });
        await store.emit(this.runId, "step", {
          name,
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
            stepId: DBOS.stepID,
            attempt: DBOS.stepStatus?.currentAttempt ?? 1,
            status: "completed",
          });
          return result;
        } catch (error) {
          await store.emit(this.runId, "step", {
            name,
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
        retriesAllowed: [
          "push",
          "change-request",
          "review-publication",
        ].includes(name),
        maxAttempts: 3,
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
      const snapshot = await workspace.prepare(project, run.branch);
      await store.patchRun(run.id, {
        base: snapshot.head,
        snapshot,
        outcome: "running",
      });
    });
  }
  async invoke(
    name: string,
    stage: Stage,
    prompt: (run: RunRecord) => string,
    readOnly = false,
  ): Promise<string> {
    return this.step(name, async (run) => {
      const { store, project, agents, signal, workspace, redact } =
        this.dependencies;
      const previous = (await store.invocations(run.id)).filter(
        (invocation) => invocation.stepId === DBOS.stepID,
      );
      if (previous.length) {
        for (const invocation of previous) {
          if (invocation.outcome === "running") {
            invocation.outcome = "interrupted";
            invocation.finishedAt = new Date().toISOString();
            if (!invocation.sessionId) invocation.sessionState = "unavailable";
            await store.saveInvocation(invocation);
          }
        }
        throw new BlockedError(
          `Interrupted agent stage ${name}; inspect existing sessions before explicit retry`,
        );
      }
      if (!run.snapshot) throw new BlockedError("Missing workspace snapshot");
      await workspace.verify(project, run.snapshot);
      const profile = resolveProfile(project.agent, stage.profile);
      const adapter = agents[profile.provider];
      if (!adapter)
        throw new Error(`Missing agent adapter ${profile.provider}`);
      const invocationSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(stage.timeoutMs),
      ]);
      const effective = await adapter.validate(profile, invocationSignal);
      const skills = await Promise.all(
        stage.skills.map(async (path) => {
          const absolute = resolve(project.checkout, path);
          const content = await readFile(absolute, "utf8");
          return {
            path: absolute,
            sha256: createHash("sha256").update(content).digest("hex"),
            content,
          };
        }),
      );
      const fullPrompt = [
        stage.prompt,
        prompt(run),
        ...skills.map(
          (skill) =>
            `Apply this selected skill (${skill.path}):\n${skill.content}`,
        ),
      ].join("\n\n");
      const id = randomUUID();
      const directory = join(this.dependencies.artifacts, run.id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const record: InvocationRecord = {
        id,
        runId: run.id,
        projectId: project.id,
        step: name,
        stepId: DBOS.stepID!,
        attempt: previous.length + 1,
        provider: profile.provider,
        sessionId: null,
        sessionState: "pending",
        requested: profile,
        effective,
        prompt: redact(fullPrompt),
        skills: skills.map((skill) => ({
          ...skill,
          content: redact(skill.content),
        })),
        outcome: "running",
        startedAt: new Date().toISOString(),
        log: join(directory, `${id}.jsonl`),
      };
      await store.saveInvocation(record);
      try {
        const output = await adapter.invoke({
          id,
          runId: run.id,
          step: name,
          cwd: project.checkout,
          prompt: fullPrompt,
          profile,
          skills: skills.map((skill) => skill.path),
          processFile: record.log + ".process.json",
          readOnly,
          signal: invocationSignal,
          session: async (sessionId) => {
            record.sessionId = sessionId;
            record.sessionState = "available";
            await store.saveInvocation(record);
          },
          event: async (event) => {
            await appendFile(record.log, redact(JSON.stringify(event)) + "\n", {
              mode: 0o600,
            });
          },
        });
        invocationSignal.throwIfAborted();
        if (readOnly) await workspace.verify(project, run.snapshot);
        else {
          const snapshot = await workspace.inspect(project);
          if (
            snapshot.head !== run.snapshot.head ||
            snapshot.branch !== run.snapshot.branch
          )
            throw new BlockedError(
              "Agent changed branch or committed unexpectedly",
            );
          await store.patchRun(run.id, { snapshot });
        }
        record.outcome = "completed";
        return redact(output);
      } catch (error) {
        record.outcome = "failed";
        throw error;
      } finally {
        record.finishedAt = new Date().toISOString();
        if (!record.sessionId) record.sessionState = "unavailable";
        await store.saveInvocation(record);
      }
    });
  }
  async implement(): Promise<void> {
    await this.invoke(
      "implementation",
      this.dependencies.project.stages.implementation,
      (run) =>
        `Implement the following issue in the current checkout. Do not commit, push, or publish.\n${run.issue.title}\n${run.issue.body}`,
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
  async writePublication(): Promise<void> {
    const output = await this.invoke(
      "writing",
      this.dependencies.project.stages.writing,
      (run) =>
        `Return ONLY JSON with commitMessage, title, description (all nonempty strings). Describe actual changes and exact validation; do not claim unrun checks. Do not modify files.\nIssue: ${JSON.stringify(run.issue)}\nDiff: ${run.snapshot?.diff}\nValidation: ${JSON.stringify(run.validation ?? [])}`,
      true,
    );
    await this.step("publication-content", async (run) => {
      await this.dependencies.store.patchRun(run.id, {
        publication: publicationSchema.parse(JSON.parse(output)),
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
    const diff = await this.step("review-input", async (run) => {
      if (!run.base || !run.head) throw new Error("Missing published revision");
      return (
        await command("git", ["diff", "--no-ext-diff", run.base, run.head], {
          cwd: this.dependencies.project.checkout,
        })
      ).stdout;
    });
    const output = await this.invoke(
      "review",
      this.dependencies.project.stages.review,
      (run) =>
        `Independently review this published revision without editing files. Return ONLY JSON {"summary":"...","findings":[{"body":"...","path":"optional relative path","line":1}]}. Omit path/line where no valid added-line location exists.\nIssue: ${JSON.stringify(run.issue)}\nExact head: ${run.head}\nValidation: ${JSON.stringify(run.validation ?? [])}\nPublished diff:\n${diff}`,
      true,
    );
    await this.step("review-content", async (run) => {
      await this.dependencies.store.patchRun(run.id, {
        review: reviewSchema.parse(JSON.parse(output)),
        reviewHead: run.head,
      });
    });
  }
  async publishReview(): Promise<void> {
    await this.step("review-publication", async (run) => {
      const { hosting, project } = this.dependencies;
      if (!run.change || !run.review || !run.reviewHead || !run.base)
        throw new Error("Missing review");
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
