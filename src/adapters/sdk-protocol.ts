import { dirname } from "node:path";
import type { ModelInfo, SessionConfig } from "@github/copilot-sdk";
import type { ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import type { AgentProfile } from "../config.js";

export interface WorkerInput {
  provider: "codex" | "copilot";
  operation: string;
  id: string;
  cwd: string;
  prompt: string;
  profile: AgentProfile;
  skills: string[];
  readOnly: boolean;
  processFile?: string;
  timeoutMs?: number;
}
export type Emit = (type: string, value: unknown) => void;
export interface CodexClient {
  startThread(options: ThreadOptions): {
    runStreamed(
      prompt: string,
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
  const turn = await thread.runStreamed(input.prompt);
  let output = "";
  for await (const event of turn.events) {
    if (event.type === "thread.started") emit("session", event.thread_id);
    emit("event", event);
    if (event.type === "item.completed" && event.item.type === "agent_message")
      output = event.item.text;
    if (event.type === "turn.failed") throw new Error(event.error.message);
    if (event.type === "error") throw new Error(event.message);
  }
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
      skillDirectories: input.skills.map(dirname),
      infiniteSessions: input.profile.context
        ? { enabled: true, ...input.profile.context }
        : undefined,
      onPermissionRequest: async (request) =>
        input.readOnly && request.kind !== "read"
          ? { kind: "denied-no-approval-rule-and-could-not-request-from-user" }
          : { kind: "approved" },
    });
    emit("session", session.sessionId);
    session.on((event) => emit("event", event));
    const response = await session.sendAndWait(
      { prompt: input.prompt },
      input.timeoutMs ?? 1_800_000,
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
