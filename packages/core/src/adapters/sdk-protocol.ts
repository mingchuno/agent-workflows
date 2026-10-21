import type {
  MessageOptions,
  ModelInfo,
  ResumeSessionConfig,
  SessionConfig,
} from "@github/copilot-sdk";
import type {
  ThreadEvent,
  ThreadOptions,
  TurnOptions,
} from "@openai/codex-sdk";
import type { AgentProfile } from "../config.js";
import { defaultStageTimeoutMs } from "../defaults.js";
import { copilotResponseSchema } from "./copilot-schema.js";
import { inspectionTool, mayReadPath } from "./inspection.js";

export interface WorkerInput {
  permissionMode?: "read-only" | "workspace-write";
  inspectionBase?: string;
  provider: "codex" | "copilot";
  operation: string;
  id: string;
  cwd: string;
  prompt: string;
  profile: AgentProfile;
  outputSchema?: Record<string, unknown>;
  resumeSessionId?: string;
  processFile?: string;
  timeoutMs?: number;
}
export type Emit = (type: string, value: unknown) => void;
interface CodexThread {
  runStreamed(
    prompt: string,
    options?: TurnOptions,
  ): Promise<{ events: AsyncIterable<ThreadEvent> }>;
}
export interface CodexClient {
  startThread(options: ThreadOptions): CodexThread;
  resumeThread(id: string, options: ThreadOptions): CodexThread;
}
export async function runCodex(
  client: CodexClient,
  input: WorkerInput,
  emit: Emit,
): Promise<void> {
  const options: ThreadOptions = {
    workingDirectory: input.cwd,
    model: input.profile.model,
    modelReasoningEffort: input.profile
      .reasoningEffort as ThreadOptions["modelReasoningEffort"],
    sandboxMode: input.permissionMode ?? "workspace-write",
    ...(input.permissionMode === "read-only"
      ? { networkAccessEnabled: false, webSearchMode: "disabled" as const }
      : {}),
    approvalPolicy: "never",
  };
  const thread = input.resumeSessionId
    ? client.resumeThread(input.resumeSessionId, options)
    : client.startThread(options);
  if (input.resumeSessionId) emit("session", input.resumeSessionId);
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
    message: MessageOptions,
    timeout: number,
  ): Promise<{ data: { content: string } } | undefined>;
  disconnect(): Promise<void>;
}
export interface CopilotClientContract {
  start(): Promise<void>;
  listModels(): Promise<ModelInfo[]>;
  createSession(options: SessionConfig): Promise<CopilotSessionClient>;
  resumeSession(
    id: string,
    options: ResumeSessionConfig,
  ): Promise<CopilotSessionClient>;
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
    const options: SessionConfig = {
      ...(input.permissionMode === "read-only"
        ? {
            enableConfigDiscovery: false,
            availableTools: [
              "view",
              "read_file",
              "glob",
              "grep",
              "inspect_git",
            ],
            tools: [inspectionTool(input.cwd, input.inspectionBase)],
            hooks: {
              onPreToolUse: async (request) => ({
                permissionDecision: [
                  "view",
                  "read_file",
                  "glob",
                  "grep",
                  "inspect_git",
                ].includes(request.toolName)
                  ? ("allow" as const)
                  : ("deny" as const),
              }),
            },
          }
        : {}),
      model: input.profile.model,
      reasoningEffort: input.profile
        .reasoningEffort as SessionConfig["reasoningEffort"],
      workingDirectory: input.cwd,
      infiniteSessions: input.profile.context
        ? { enabled: true, ...input.profile.context }
        : undefined,
      onPermissionRequest: async (request) =>
        request.managedApprovalRequired ||
        (input.permissionMode === "read-only" &&
          (request.kind !== "read" ||
            !(await mayReadPath(input.cwd, request.path))))
          ? { kind: "reject" }
          : { kind: "approve-once" },
    };
    const session = input.resumeSessionId
      ? await client.resumeSession(input.resumeSessionId, {
          ...options,
          continuePendingWork: false,
        })
      : await client.createSession({ ...options, sessionId: input.id });
    emit("session", session.sessionId);
    session.on((event) => emit("event", event));
    const response = await session.sendAndWait(
      {
        prompt: input.prompt,
        responseSchema: input.outputSchema
          ? copilotResponseSchema(input.outputSchema)
          : undefined,
      },
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
