import type { ModelInfo, SessionConfig } from "@github/copilot-sdk";
import type {
  ThreadEvent,
  ThreadOptions,
  TurnOptions,
} from "@openai/codex-sdk";
import type { AgentProfile } from "../config.js";
import { defaultStageTimeoutMs } from "../defaults.js";
import type { ChangeEvidence } from "../evidence.js";
import { createEvidenceTools } from "./evidence-tools.js";

export interface WorkerInput {
  provider: "codex" | "copilot";
  operation: string;
  id: string;
  cwd: string;
  prompt: string;
  profile: AgentProfile;
  outputSchema?: unknown;
  readOnly: boolean;
  processFile?: string;
  timeoutMs?: number;
  evidence?: ChangeEvidence;
}
export type Emit = (type: string, value: unknown) => void;
export interface CodexClient {
  startThread(options: ThreadOptions): {
    runStreamed(
      prompt: string,
      options?: TurnOptions,
    ): Promise<{ events: AsyncIterable<ThreadEvent> }>;
  };
}
export async function runCodex(
  client: CodexClient,
  input: WorkerInput,
  emit: Emit,
): Promise<void> {
  const thread = client.startThread({
    workingDirectory: input.cwd,
    model: input.profile.model,
    modelReasoningEffort: input.profile
      .reasoningEffort as ThreadOptions["modelReasoningEffort"],
    sandboxMode: input.readOnly ? "read-only" : "workspace-write",
    approvalPolicy: "never",
  });
  const turn = await thread.runStreamed(input.prompt, {
    outputSchema: input.outputSchema,
  });
  let output = "";
  let completed = false;
  for await (const event of turn.events) {
    if (event.type === "thread.started") emit("session", event.thread_id);
    emit("event", event);
    if (event.type === "item.completed" && event.item.type === "agent_message")
      output = event.item.text;
    if (event.type === "turn.completed") completed = true;
    if (event.type === "turn.failed") throw new Error(event.error.message);
    if (event.type === "error") throw new Error(event.message);
  }
  if (!completed) throw new Error("Codex stream ended before turn.completed");
  emit("result", output);
}
export interface CopilotSessionClient {
  sessionId: string;
  on(handler: (event: unknown) => void): unknown;
  sendAndWait(
    message: { prompt: string },
    timeout: number,
  ): Promise<{ data: { content: string } } | undefined>;
  disconnect(): Promise<void>;
}
export interface CopilotClientContract {
  start(): Promise<void>;
  listModels(): Promise<ModelInfo[]>;
  createSession(options: SessionConfig): Promise<CopilotSessionClient>;
  stop(): Promise<Error[]>;
  forceStop(): Promise<void>;
}
export async function runCopilot(
  client: CopilotClientContract,
  input: WorkerInput,
  emit: Emit,
): Promise<void> {
  try {
    if (input.operation === "models") {
      await client.start();
      emit(
        "result",
        JSON.stringify(
          (await client.listModels()).map((model) => ({
            id: model.id,
            reasoningEfforts: model.supportedReasoningEfforts ?? [],
            contextWindowTokens:
              model.capabilities.limits.max_context_window_tokens,
          })),
        ),
      );
      return;
    }
    const session = await client.createSession({
      sessionId: input.id,
      model: input.profile.model,
      reasoningEffort: input.profile
        .reasoningEffort as SessionConfig["reasoningEffort"],
      workingDirectory: input.cwd,
      infiniteSessions: input.profile.context
        ? { enabled: true, ...input.profile.context }
        : undefined,
      tools:
        input.readOnly && input.evidence
          ? createEvidenceTools(input.evidence, emit)
          : undefined,
      onPermissionRequest: async (request) =>
        request.managedApprovalRequired ||
        (input.readOnly && request.kind !== "read")
          ? { kind: "reject" }
          : { kind: "approve-once" },
    });
    emit("session", session.sessionId);
    session.on((event) => emit("event", event));
    const response = await session.sendAndWait(
      { prompt: input.prompt },
      input.timeoutMs ?? defaultStageTimeoutMs,
    );
    emit("result", response?.data.content ?? "");
    await session.disconnect();
  } finally {
    const errors = await client.stop();
    if (errors.length) {
      await client.forceStop();
      // biome-ignore lint/correctness/noUnsafeFinally: Preserve the existing shutdown-failure contract.
      throw new AggregateError(errors, "Copilot shutdown failed");
    }
  }
}
