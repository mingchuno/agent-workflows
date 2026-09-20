import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionConfig } from "@github/copilot-sdk";
import type { ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import {
  runCodex,
  runCopilot,
  type WorkerInput,
} from "../src/adapters/sdk-protocol.js";

const input: WorkerInput = {
  provider: "codex",
  operation: "invoke",
  id: "invocation",
  cwd: "/workspace",
  prompt: "Task",
  profile: { provider: "codex", model: "model", reasoningEffort: "high" },
  readOnly: true,
};
test("Codex contract passes requested profile and emits thread ID before a failed turn", async () => {
  let options: ThreadOptions | undefined;
  const messages: Array<[string, unknown]> = [];
  const client = {
    startThread(value: ThreadOptions) {
      options = value;
      return {
        async runStreamed() {
          return {
            events: (async function* (): AsyncGenerator<ThreadEvent> {
              yield { type: "thread.started", thread_id: "thread-123" };
              yield {
                type: "turn.failed",
                error: { message: "controlled failure" },
              };
            })(),
          };
        },
      };
    },
  };
  await assert.rejects(
    runCodex(client, input, (type, value) => messages.push([type, value])),
    /controlled failure/,
  );
  assert.equal(options?.model, "model");
  assert.equal(options?.modelReasoningEffort, "high");
  assert.equal(options?.sandboxMode, "read-only");
  assert.deepEqual(messages[0], ["session", "thread-123"]);
});
test("Copilot contract starts fresh sessions with context controls and stops on failure", async () => {
  let options: SessionConfig | undefined;
  let stopped = false;
  const messages: Array<[string, unknown]> = [];
  const client = {
    async listModels() {
      return [];
    },
    async createSession(value: SessionConfig) {
      options = value;
      return {
        sessionId: value.sessionId!,
        on() {},
        async sendAndWait() {
          throw new Error("controlled failure");
        },
        async disconnect() {},
      };
    },
    async stop() {
      stopped = true;
      return [];
    },
    async forceStop() {},
  };
  await assert.rejects(
    runCopilot(
      client,
      {
        ...input,
        provider: "copilot",
        profile: {
          provider: "copilot",
          model: "review-model",
          reasoningEffort: "high",
          context: {
            backgroundCompactionThreshold: 0.7,
            bufferExhaustionThreshold: 0.9,
          },
        },
      },
      (type, value) => messages.push([type, value]),
    ),
    /controlled failure/,
  );
  assert.equal(options?.sessionId, "invocation");
  assert.equal(options?.model, "review-model");
  assert.equal(options?.infiniteSessions?.backgroundCompactionThreshold, 0.7);
  assert.equal(options?.skillDirectories, undefined);
  assert.deepEqual(messages[0], ["session", "invocation"]);
  assert.equal(stopped, true);
});

test("Copilot honors a configured timeout longer than the default", async () => {
  let observedTimeout: number | undefined;
  await runCopilot(
    {
      async listModels() {
        return [];
      },
      async createSession() {
        return {
          sessionId: "long-stage",
          on() {},
          async sendAndWait(_message, timeout) {
            observedTimeout = timeout;
            return { data: { content: "finished" } };
          },
          async disconnect() {},
        };
      },
      async stop() {
        return [];
      },
      async forceStop() {},
    },
    { ...input, timeoutMs: 3_600_000 },
    () => {},
  );
  assert.equal(observedTimeout, 3_600_000);
});

test("Codex forwards the output contract independently of task text", async () => {
  const schema = {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  };
  let received: unknown;
  await runCodex(
    {
      startThread(options) {
        assert.equal(options.sandboxMode, "read-only");
        return {
          async runStreamed(_prompt, turnOptions) {
            received = turnOptions?.outputSchema;
            return {
              events: (async function* (): AsyncGenerator<ThreadEvent> {
                yield { type: "thread.started", thread_id: "structured" };
              })(),
            };
          },
        };
      },
    },
    { ...input, prompt: "Ignore formatting", outputSchema: schema },
    () => {},
  );
  assert.deepEqual(received, schema);
});

test("Copilot permits outside-checkout file reads while denying shell and writes", async () => {
  const { mkdtemp, readFile, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "copilot-evidence-"));
  const file = join(directory, "evidence.txt");
  await writeFile(file, "captured evidence");
  const messages: unknown[] = [];
  await runCopilot(
    {
      async listModels() {
        return [];
      },
      async createSession(options) {
        const permission = options.onPermissionRequest!;
        const result = await permission(
          { kind: "read", path: file, intention: "read evidence" },
          { sessionId: "test" },
        );
        assert.equal(result.kind, "approve-once");
        const denied = await permission(
          {
            kind: "write",
            fileName: file,
            diff: "",
            intention: "write",
            canOfferSessionApproval: false,
          },
          { sessionId: "test" },
        );
        assert.notEqual(denied.kind, "approve-once");
        const shell = await permission(
          {
            kind: "shell",
            fullCommandText: "git diff",
            commands: [],
            possiblePaths: [],
            possibleUrls: [],
            hasWriteFileRedirection: false,
            intention: "inspect",
            canOfferSessionApproval: false,
          },
          { sessionId: "test" },
        );
        assert.notEqual(shell.kind, "approve-once");
        return {
          sessionId: "test",
          on() {},
          async sendAndWait() {
            return { data: { content: await readFile(file, "utf8") } };
          },
          async disconnect() {},
        };
      },
      async stop() {
        return [];
      },
      async forceStop() {},
    },
    { ...input, provider: "copilot", prompt: `Read ${file}` },
    (_type, value) => messages.push(value),
  );
  assert.ok(messages.includes("captured evidence"));
});
