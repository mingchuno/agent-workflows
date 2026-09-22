import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { resolveProfile, type Stage } from "./config.js";
import {
  BlockedError,
  type ContributionCandidate,
  type RunRecord,
  type Snapshot,
} from "./domain.js";
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
}
interface AttemptInput {
  number: number;
  correction: string;
  contribution?: ContributionCandidate;
}
type AttemptResult =
  | { kind: "completed"; output: string }
  | {
      kind: "correction";
      correction: string;
      contribution?: ContributionCandidate;
    };

/** One logical stage; only returned format errors admit a second response attempt. */
export async function invokeStage(execution: StageExecution): Promise<string> {
  const prepared = await prepareStage(execution);
  let attempt: AttemptInput = { number: 1, correction: "" };
  while (attempt.number <= maxInvocationAttempts) {
    const result = await invokeAttempt(execution, prepared, attempt);
    if (result.kind === "completed") return result.output;
    attempt = {
      number: attempt.number + 1,
      correction: result.correction,
      contribution: result.contribution,
    };
  }
  throw new Error("Format correction exhausted");
}

async function refusePreviousInvocations(
  execution: StageExecution,
): Promise<void> {
  const {
    run,
    name,
    stepId,
    dependencies: { store },
  } = execution;
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
}

function prepareRequest(execution: StageExecution) {
  const { run, stage, task, dependencies } = execution;
  const { project } = dependencies;
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
  return { resolved, outputSchema, fullPrompt, profile };
}

async function prepareStage(execution: StageExecution) {
  const { run, stage, task, dependencies } = execution;
  const { project, agents, signal, workspace } = dependencies;
  await refusePreviousInvocations(execution);
  if (!run.snapshot) throw new BlockedError("Missing workspace snapshot");
  await workspace.verify(project, run.snapshot);
  if (task.evidence) await verifyEvidence(task.evidence);
  const request = prepareRequest(execution);
  const { profile } = request;
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
  return {
    ...request,
    adapter,
    effective,
    deadline,
    invocationSignal,
    directory,
  };
}

type PreparedStage = Awaited<ReturnType<typeof prepareStage>>;

async function invokeAttempt(
  execution: StageExecution,
  prepared: PreparedStage,
  attempt: AttemptInput,
): Promise<AttemptResult> {
  const { run, name, task, stepId, dependencies } = execution;
  const { store, project, workspace, redact } = dependencies;
  const {
    profile,
    effective,
    resolved,
    outputSchema,
    fullPrompt,
    directory,
    invocationSignal,
  } = prepared;
  invocationSignal.throwIfAborted();
  const expected = (await store.run(run.id)).snapshot!;
  await workspace.verify(project, expected);
  if (task.evidence) await verifyEvidence(task.evidence);
  const id = randomUUID();
  const prompt = fullPrompt + attempt.correction;
  const readOnly =
    task.readOnly === true || attempt.number === maxInvocationAttempts;
  const record: InvocationRecord = {
    id,
    runId: run.id,
    projectId: project.id,
    step: name,
    stepId,
    attempt: attempt.number,
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
    const output = await invokeProvider(execution, prepared, {
      record,
      prompt,
      readOnly,
    });
    await appendFile(record.log, "", { mode: 0o600 });
    invocationSignal.throwIfAborted();
    let contribution = attempt.contribution;
    if (readOnly) await workspace.verify(project, expected);
    else
      contribution = await saveImplementationSnapshot(
        run.id,
        expected,
        profile.provider,
        dependencies,
      );
    if (task.evidence) await verifyEvidence(task.evidence);
    invocationSignal.throwIfAborted();
    const response = validateResponse(output, task.outputContract);
    if (response.kind === "invalid") {
      const correction = await recordInvalidResponse(
        record,
        output,
        response.error,
        redact,
      );
      return { kind: "correction", correction, contribution };
    }
    if (contribution)
      await acceptContribution(run.id, contribution, dependencies);
    record.outcome = "completed";
    return {
      kind: "completed",
      output: redact(
        task.outputContract ? JSON.stringify(response.parsed) : output,
      ),
    };
  } catch (error) {
    if (record.outcome === "running") record.outcome = "failed";
    throw error;
  } finally {
    record.finishedAt = new Date().toISOString();
    if (!record.sessionId) record.sessionState = "unavailable";
    await store.saveInvocation(record);
  }
}

async function invokeProvider(
  execution: StageExecution,
  prepared: PreparedStage,
  attempt: { record: InvocationRecord; prompt: string; readOnly: boolean },
): Promise<string> {
  const {
    run,
    name,
    dependencies: { project, store, redact },
  } = execution;
  const { adapter, profile, outputSchema, invocationSignal, deadline } =
    prepared;
  const { record, prompt, readOnly } = attempt;
  return adapter.invoke({
    id: record.id,
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
}

/** Only returned output validation failures qualify for correction. */
function validateResponse(
  output: string,
  contract?: z.ZodType,
):
  | { kind: "valid"; parsed: unknown }
  | { kind: "invalid"; error: SyntaxError | z.ZodError } {
  let parsed: unknown;
  try {
    parsed = contract ? contract.parse(JSON.parse(output)) : undefined;
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof z.ZodError))
      throw error;
    return { kind: "invalid", error };
  }
  return { kind: "valid", parsed };
}

async function recordInvalidResponse(
  record: InvocationRecord,
  output: string,
  error: SyntaxError | z.ZodError,
  redact: (text: string) => string,
): Promise<string> {
  record.outcome = "invalid-output";
  record.validationError = redact(String(error));
  await appendFile(
    record.log,
    redact(
      JSON.stringify({ type: "invalid-output", output, error: String(error) }),
    ) + "\n",
  );
  if (record.attempt === maxInvocationAttempts)
    throw new Error(`Invalid output after one correction: ${String(error)}`);
  return `\n\nCorrect the prior response format in this fresh inspection-only session. Do not modify files.\nPrior invalid response:\n${output}\nValidation errors:\n${String(error)}`;
}

async function saveImplementationSnapshot(
  runId: string,
  expected: Snapshot,
  provider: string,
  dependencies: OperationDependencies,
): Promise<ContributionCandidate | undefined> {
  const { workspace, project, store } = dependencies;
  const snapshot = await workspace.inspect(project);
  if (snapshot.head !== expected.head || snapshot.branch !== expected.branch)
    throw new BlockedError("Agent changed branch or committed unexpectedly");
  await store.patchRun(runId, { snapshot });
  return snapshot.fingerprint === expected.fingerprint
    ? undefined
    : {
        provider,
        beforeFiles: expected.files,
        afterFiles: snapshot.files,
      };
}

async function acceptContribution(
  runId: string,
  candidate: ContributionCandidate,
  dependencies: OperationDependencies,
): Promise<void> {
  const run = await dependencies.store.run(runId);
  await dependencies.store.patchRun(runId, {
    contributionCandidates: [...(run.contributionCandidates ?? []), candidate],
  });
}
