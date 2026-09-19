import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentProfile } from "../config.js";
import type {
  AgentAdapter,
  AgentInvocation,
  EffectiveProfile,
} from "../domain.js";
import { command } from "../runtime/process.js";

interface ModelCapability {
  id: string;
  reasoningEfforts: string[];
  contextWindowTokens?: number;
}
export interface SDKAgentOptions {
  models?: ModelCapability[];
}
/** Runs each SDK invocation in an owned process group; no cross-stage session reuse. */
export class SDKAgent implements AgentAdapter {
  constructor(
    readonly provider: "codex" | "copilot",
    readonly options: SDKAgentOptions = {},
  ) {}
  async validate(
    profile: AgentProfile,
    signal?: AbortSignal,
  ): Promise<EffectiveProfile> {
    if (profile.provider !== this.provider)
      throw new Error("Profile provider does not match adapter");
    if (this.provider === "codex" && profile.context)
      throw new Error("Codex SDK does not expose runtime context controls");
    const context = profile.context;
    if (
      context &&
      (context.backgroundCompactionThreshold ?? 0.8) >=
        (context.bufferExhaustionThreshold ?? 0.95)
    )
      throw new Error(
        "Background compaction threshold must precede buffer exhaustion",
      );
    let models = this.options.models;
    if (
      !models &&
      this.provider === "codex" &&
      (profile.model || profile.reasoningEffort)
    ) {
      try {
        const cache = JSON.parse(
          await readFile(
            join(
              process.env.CODEX_HOME ?? join(homedir(), ".codex"),
              "models_cache.json",
            ),
            "utf8",
          ),
        ) as {
          models: Array<{
            slug: string;
            supported_reasoning_levels?: Array<{ effort: string }>;
            context_window?: number;
          }>;
        };
        models = cache.models.map((model) => ({
          id: model.slug,
          reasoningEfforts:
            model.supported_reasoning_levels?.map((level) => level.effort) ??
            [],
          contextWindowTokens: model.context_window,
        }));
      } catch {
        throw new Error(
          "Cannot validate explicit Codex settings: refresh the local Codex model catalog or supply SDKAgent models",
        );
      }
    }
    if (
      !models &&
      this.provider === "copilot" &&
      (profile.model || profile.reasoningEffort)
    ) {
      const result = await this.worker(
        { operation: "models" },
        undefined,
        signal,
      );
      models = JSON.parse(result) as ModelCapability[];
    }
    const model = models?.find((candidate) => candidate.id === profile.model);
    if (profile.model && !model)
      throw new Error(
        `Model capability information unavailable: ${profile.model}`,
      );
    if (
      profile.reasoningEffort &&
      !model?.reasoningEfforts.includes(profile.reasoningEffort)
    )
      throw new Error(
        `Unsupported reasoning effort ${profile.reasoningEffort} for ${profile.model ?? "unspecified model"}`,
      );
    return {
      provider: this.provider,
      model: profile.model ?? "unknown",
      reasoningEffort: profile.reasoningEffort ?? "unknown",
      context: context ?? "unknown",
      contextWindowTokens: model?.contextWindowTokens ?? "unknown",
    };
  }
  async invoke(invocation: AgentInvocation): Promise<string> {
    return this.worker(
      {
        operation: "invoke",
        id: invocation.id,
        cwd: invocation.cwd,
        prompt: invocation.prompt,
        profile: invocation.profile,
        skills: invocation.skills,
        readOnly: invocation.readOnly,
      },
      invocation,
    );
  }
  private async worker(
    input: Record<string, unknown>,
    invocation: AgentInvocation | undefined,
    signal = invocation?.signal,
  ): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "agent-workflows-sdk-"));
    const path = join(directory, "input.json");
    await writeFile(
      path,
      JSON.stringify({
        ...input,
        provider: this.provider,
        processFile: invocation?.processFile,
      }),
      { mode: 0o600 },
    );
    const ownPath = fileURLToPath(import.meta.url);
    const source = ownPath.endsWith(".ts");
    const worker = join(
      dirname(ownPath),
      `agent-worker.${source ? "ts" : "js"}`,
    );
    let buffer = "",
      output = "",
      events = Promise.resolve();
    let eventError: unknown;
    const persistenceFailure = new AbortController();
    try {
      await command(
        process.execPath,
        [
          ...(source ? ["--import", import.meta.resolve("tsx")] : []),
          worker,
          path,
        ],
        {
          cwd: invocation?.cwd ?? process.cwd(),
          signal: AbortSignal.any([
            persistenceFailure.signal,
            ...(signal ? [signal] : []),
          ]),
          captureOutput: false,
          processFile: invocation?.processFile,
          timeoutMs: invocation ? 1_800_000 : 30_000,
          onOutput: (chunk) => {
            buffer += chunk;
            for (;;) {
              const newline = buffer.indexOf("\n");
              if (newline < 0) break;
              const line = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              if (!line.startsWith("AW:")) continue;
              const message = JSON.parse(line.slice(3)) as {
                type: string;
                value: string;
              };
              if (message.type === "result") output = message.value;
              else
                events = events
                  .then(async () => {
                    if (message.type === "session")
                      await invocation?.session(message.value);
                    else await invocation?.event(message.value);
                  })
                  .catch((error) => {
                    eventError = error;
                    persistenceFailure.abort();
                  });
            }
          },
        },
      );
      await events;
      if (eventError) throw eventError;
      return output;
    } finally {
      await events;
      await rm(directory, { recursive: true, force: true });
    }
  }
}
export function createAgents() {
  return { codex: new SDKAgent("codex"), copilot: new SDKAgent("copilot") };
}
