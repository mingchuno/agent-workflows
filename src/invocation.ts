import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { resolveProfile, type Stage } from "./config.js";
import { BlockedError, type RunRecord, type Snapshot } from "./domain.js";
import { type ChangeEvidence, verifyEvidence } from "./evidence.js";
import type { OperationDependencies } from "./operations.js";
import { resolveStagePrompt, sha256 } from "./prompts.js";
import type { InvocationRecord } from "./store.js";

const maxInvocationAttempts = 2;

export interface InvocationTask {
  defaultPrompt: string;
  context?: (run: RunRecord) => string;
  readOnly?: boolean;
  outputContract?: z.ZodType;
  evidence?: ChangeEvidence;
}

interface StageExecution {
  run: RunRecord;
  name: string;
  stage: Stage;
  task: InvocationTask;
  stepId: number;
  dependencies: OperationDependencies;
  saveImplementationSnapshot: (
    runId: string,
    snapshot: Snapshot,
    provider: string,
  ) => Promise<void>;
}
/** One logical stage; only returned format errors admit a second response attempt. */
export async function invokeStage({
  run,
  name,
  stage,
  task,
  stepId,
  dependencies,
  saveImplementationSnapshot,
}: StageExecution): Promise<string> {
  const { store, project, agents, signal, workspace, redact } = dependencies;
  const previous = (await store.invocations(run.id)).filter(
    (item) => item.stepId === stepId,
  );
  if (previous.length) {
    for (const record of previous) {
      if (record.outcome !== "running") continue;
      record.outcome = "interrupted";
      record.finishedAt = new Date().toISOString();
      if (!record.sessionId) record.sessionState = "unavailable";
      await store.saveInvocation(record);
    }
    throw new BlockedError(
      `Interrupted agent stage ${name}; inspect existing sessions before explicit retry`,
    );
  }
  if (!run.snapshot) throw new BlockedError("Missing workspace snapshot");
  await workspace.verify(project, run.snapshot);
  if (task.evidence) await verifyEvidence(task.evidence);
  const resolved = resolveStagePrompt(
    stage,
    task.defaultPrompt,
    dependencies.promptBaseDirectory,
  );
  const outputSchema = task.outputContract
    ? z.toJSONSchema(task.outputContract)
    : undefined;
  const contract = outputSchema
    ? `Return ONLY JSON satisfying this application-owned schema:\n${JSON.stringify(outputSchema)}`
    : "";
  const fullPrompt = [
    resolved.content,
    `Run context:\n${task.context?.(run) ?? ""}`,
    task.readOnly
      ? "Inspection only. Do not modify files, commit, push, or publish."
      : "Do not commit, push, or publish.",
    contract,
  ].join("\n\n");
  const profile = resolveProfile(project.agent, stage.profile);
  const adapter = agents[profile.provider];
  if (!adapter) throw new Error(`Missing agent adapter ${profile.provider}`);
  const deadline = Date.now() + stage.timeoutMs;
  const invocationSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(stage.timeoutMs),
  ]);
  const effective = await adapter.validate(profile, invocationSignal);
  const directory = join(dependencies.artifacts, run.id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let correction = "";
  for (let attempt = 1; attempt <= maxInvocationAttempts; attempt++) {
    invocationSignal.throwIfAborted();
    const expected = (await store.run(run.id)).snapshot!;
    await workspace.verify(project, expected);
    if (task.evidence) await verifyEvidence(task.evidence);
    const id = randomUUID();
    const prompt = fullPrompt + correction;
    const readOnly =
      task.readOnly === true || attempt === maxInvocationAttempts;
    const record: InvocationRecord = {
      id,
      runId: run.id,
      projectId: project.id,
      step: name,
      stepId,
      attempt,
      provider: profile.provider,
      sessionId: null,
      sessionState: "pending",
      requested: profile,
      effective,
      prompt: redact(prompt),
      taskPrompt: { ...resolved, content: redact(resolved.content) },
      outputContract: outputSchema
        ? sha256(JSON.stringify(outputSchema))
        : undefined,
      evidence: task.evidence,
      outcome: "running",
      startedAt: new Date().toISOString(),
      log: join(directory, `${id}.jsonl`),
    };
    await store.saveInvocation(record);
    try {
      invocationSignal.throwIfAborted();
      const output = await adapter.invoke({
        id,
        runId: run.id,
        step: name,
        cwd: project.checkout,
        prompt,
        profile,
        outputSchema,
        processFile: record.log + ".process.json",
        readOnly,
        signal: invocationSignal,
        timeoutMs: Math.max(1, deadline - Date.now()),
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
      await appendFile(record.log, "", { mode: 0o600 });
      invocationSignal.throwIfAborted();
      if (readOnly) await workspace.verify(project, expected);
      else await saveImplementationSnapshot(run.id, expected, profile.provider);
      if (task.evidence) await verifyEvidence(task.evidence);
      invocationSignal.throwIfAborted();
      // Only returned output validation failures qualify for correction.
      let parsed: unknown;
      try {
        parsed = task.outputContract
          ? task.outputContract.parse(JSON.parse(output))
          : undefined;
      } catch (error) {
        if (!(error instanceof SyntaxError) && !(error instanceof z.ZodError))
          throw error;
        record.outcome = "invalid-output";
        record.validationError = redact(String(error));
        await appendFile(
          record.log,
          redact(
            JSON.stringify({
              type: "invalid-output",
              output,
              error: String(error),
            }),
          ) + "\n",
        );
        if (attempt === maxInvocationAttempts)
          throw new Error(
            `Invalid output after one correction: ${String(error)}`,
          );
        correction = `\n\nCorrect the prior response format in this fresh inspection-only session. Do not modify files.\nPrior invalid response:\n${output}\nValidation errors:\n${String(error)}`;
        continue;
      }
      record.outcome = "completed";
      return redact(task.outputContract ? JSON.stringify(parsed) : output);
    } catch (error) {
      if (record.outcome === "running") record.outcome = "failed";
      throw error;
    } finally {
      record.finishedAt = new Date().toISOString();
      if (!record.sessionId) record.sessionState = "unavailable";
      await store.saveInvocation(record);
    }
  }
  throw new Error("Format correction exhausted");
}
