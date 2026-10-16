import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionConfig } from "@github/copilot-sdk";
import type { ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import { z } from "zod";
import {
  type CopilotClientContract,
  runCodex,
  runCopilot,
  type WorkerInput,
} from "../packages/core/src/adapters/sdk-protocol.js";
import { reviewSchema } from "../packages/core/src/domain.js";

const input: WorkerInput = {
  provider: "codex",
  operation: "invoke",
  id: "invocation",
  cwd: "/workspace",
  prompt: "Task",
  profile: { provider: "codex", model: "model", reasoningEffort: "high" },
};

for (const stage of ["review", "publication", "correction", "text"]) {
  test(`Copilot forwards the ${stage} output contract to the SDK`, async () => {
    const schema =
      stage === "text"
        ? undefined
        : {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false,
          };
    const resumeSessionId =
      stage === "publication" || stage === "correction"
        ? "implementation-session"
        : undefined;
    const messages: Array<[string, unknown]> = [];
    const session = {
      sessionId: resumeSessionId ?? input.id,
      on() {},
      async sendAndWait(
        message: { prompt: string; responseSchema?: unknown },
        timeout: number,
      ) {
        assert.equal(message.prompt, stage);
        assert.deepEqual(message.responseSchema, schema);
        assert.equal(timeout, 1234);
        return { data: { content: '{"text":"result"}' } };
      },
      async disconnect() {},
    };
    await runCopilot(
      {
        async start() {},
        async listModels() {
          return [];
        },
        async createSession() {
          assert.equal(resumeSessionId, undefined);
          return session;
        },
        async resumeSession(id) {
          assert.equal(id, resumeSessionId);
          return session;
        },
        async stop() {
          return [];
        },
        async forceStop() {},
      },
      {
        ...input,
        provider: "copilot",
        prompt: stage,
        outputSchema: schema,
        resumeSessionId,
        timeoutMs: 1234,
      },
      (type, value) => messages.push([type, value]),
    );
    assert.deepEqual(messages.at(-1), ["result", '{"text":"result"}']);
  });
}

test("Codex resumes the supplied thread with implementation permissions and stage settings", async () => {
  const messages: Array<[string, unknown]> = [];
  await runCodex(
    {
      startThread() {
        throw new Error("must resume");
      },
      resumeThread(id, options) {
        assert.equal(id, "implementation-thread");
        assert.equal(options.model, "model");
        assert.equal(options.modelReasoningEffort, "high");
        assert.equal(options.sandboxMode, "workspace-write");
        assert.equal(options.approvalPolicy, "never");
        return {
          async runStreamed() {
            return {
              events: (async function* (): AsyncGenerator<ThreadEvent> {
                yield {
                  type: "turn.completed",
                  usage: {
                    input_tokens: 0,
                    cached_input_tokens: 0,
                    cache_write_input_tokens: 0,
                    output_tokens: 0,
                    reasoning_output_tokens: 0,
                  },
                };
              })(),
            };
          },
        };
      },
    },
    { ...input, resumeSessionId: "implementation-thread" },
    (type, value) => messages.push([type, value]),
  );
  assert.deepEqual(messages[0], ["session", "implementation-thread"]);
});

test("Copilot resumes the supplied session and reinstalls implementation permissions", async () => {
  const messages: Array<[string, unknown]> = [];
  await runCopilot(
    {
      async start() {},
      async listModels() {
        return [];
      },
      async createSession() {
        throw new Error("must resume");
      },
      async resumeSession(id, options) {
        assert.equal(id, "implementation-session");
        assert.equal(options.model, "model");
        assert.equal(options.workingDirectory, input.cwd);
        assert.equal(options.continuePendingWork, false);
        const permission = options.onPermissionRequest!;
        const request = {
          kind: "shell",
          fullCommandText: "git diff",
          commands: [],
          possiblePaths: [],
          possibleUrls: [],
          hasWriteFileRedirection: false,
          intention: "inspect",
          canOfferSessionApproval: false,
        } as const;
        assert.equal(
          (
            await permission(
              { ...request, commands: [], possiblePaths: [], possibleUrls: [] },
              { sessionId: id },
            )
          ).kind,
          "approve-once",
        );
        assert.equal(
          (
            await permission(
              {
                ...request,
                commands: [],
                possiblePaths: [],
                possibleUrls: [],
                managedApprovalRequired: true,
              },
              { sessionId: id },
            )
          ).kind,
          "reject",
        );
        return {
          sessionId: id,
          on() {},
          async sendAndWait() {
            return { data: { content: "publication" } };
          },
          async disconnect() {},
        };
      },
      async stop() {
        return [];
      },
      async forceStop() {},
    },
    {
      ...input,
      provider: "copilot",
      profile: { ...input.profile, provider: "copilot" },
      resumeSessionId: "implementation-session",
    },
    (type, value) => messages.push([type, value]),
  );
  assert.deepEqual(messages[0], ["session", "implementation-session"]);
  assert.deepEqual(messages.at(-1), ["result", "publication"]);
});
test("Codex contract passes requested profile and emits thread ID before a failed turn", async () => {
  let options: ThreadOptions | undefined;
  const messages: Array<[string, unknown]> = [];
  const client = {
    resumeThread() {
      throw new Error("unexpected resume");
    },
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
  assert.equal(options?.sandboxMode, "workspace-write");
  assert.deepEqual(messages[0], ["session", "thread-123"]);
});
test("Codex rejects a stream that ends before turn completion", async () => {
  const messages: Array<[string, unknown]> = [];
  await assert.rejects(
    runCodex(
      {
        resumeThread() {
          throw new Error("unexpected resume");
        },
        startThread() {
          return {
            async runStreamed() {
              return {
                events: (async function* (): AsyncGenerator<ThreadEvent> {
                  yield { type: "thread.started", thread_id: "partial" };
                  yield {
                    type: "item.completed",
                    item: {
                      type: "agent_message",
                      id: "message",
                      text: '{"result":',
                    },
                  } as ThreadEvent;
                })(),
              };
            },
          };
        },
      },
      input,
      (type, value) => messages.push([type, value]),
    ),
    /ended before turn.completed/,
  );
  assert.equal(
    messages.some(([type]) => type === "result"),
    false,
  );
});
test("Copilot contract starts fresh sessions with context controls and stops on failure", async () => {
  let options: SessionConfig | undefined;
  let stopped = false;
  const messages: Array<[string, unknown]> = [];
  const client = {
    async start() {},
    async listModels() {
      return [];
    },
    async resumeSession() {
      throw new Error("unexpected resume");
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

test("Copilot model discovery connects before listing and closes afterward", async () => {
  const calls: string[] = [];
  const messages: Array<[string, unknown]> = [];
  await runCopilot(
    {
      async start() {
        calls.push("start");
      },
      async listModels() {
        calls.push("listModels");
        return [
          {
            id: "model",
            supportedReasoningEfforts: ["high"],
            capabilities: { limits: { max_context_window_tokens: 128_000 } },
          },
        ] as Awaited<ReturnType<CopilotClientContract["listModels"]>>;
      },
      async resumeSession() {
        throw new Error("unexpected resume");
      },
      async createSession() {
        throw new Error("model discovery must not create a session");
      },
      async stop() {
        calls.push("stop");
        return [];
      },
      async forceStop() {},
    },
    { ...input, provider: "copilot", operation: "models" },
    (type, value) => messages.push([type, value]),
  );
  assert.deepEqual(calls, ["start", "listModels", "stop"]);
  assert.deepEqual(JSON.parse(messages[0]?.[1] as string), [
    { id: "model", reasoningEfforts: ["high"], contextWindowTokens: 128_000 },
  ]);
});

test("Copilot honors a configured timeout longer than the default", async () => {
  let observedTimeout: number | undefined;
  await runCopilot(
    {
      async start() {},
      async listModels() {
        return [];
      },
      async resumeSession() {
        throw new Error("unexpected resume");
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

test("Codex forwards the bounded review contract independently of task text", async () => {
  const schema = z.toJSONSchema(reviewSchema);
  let received: unknown;
  await runCodex(
    {
      resumeThread() {
        throw new Error("unexpected resume");
      },
      startThread(options) {
        assert.equal(options.sandboxMode, "workspace-write");
        return {
          async runStreamed(_prompt, turnOptions) {
            received = turnOptions?.outputSchema;
            return {
              events: (async function* (): AsyncGenerator<ThreadEvent> {
                yield { type: "thread.started", thread_id: "structured" };
                yield {
                  type: "turn.completed",
                  usage: {
                    input_tokens: 0,
                    cached_input_tokens: 0,
                    cache_write_input_tokens: 0,
                    output_tokens: 0,
                    reasoning_output_tokens: 0,
                  },
                };
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

test("Copilot approves reads, shell and writes with implementation permissions", async () => {
  const { mkdtemp, readFile, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "copilot-evidence-"));
  const file = join(directory, "evidence.txt");
  await writeFile(file, "captured evidence");
  const messages: unknown[] = [];
  await runCopilot(
    {
      async start() {},
      async listModels() {
        return [];
      },
      async resumeSession() {
        throw new Error("unexpected resume");
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
        assert.equal(denied.kind, "approve-once");
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
        assert.equal(shell.kind, "approve-once");
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

async function copilotResponseSchema(
  schema: Record<string, unknown>,
  resumeSessionId?: string,
) {
  let received: unknown;
  const session = {
    sessionId: resumeSessionId ?? input.id,
    on() {},
    async sendAndWait(message: { responseSchema?: unknown }) {
      received = message.responseSchema;
      return { data: { content: "{}" } };
    },
    async disconnect() {},
  };
  await runCopilot(
    {
      async start() {},
      async listModels() {
        return [];
      },
      async createSession() {
        return session;
      },
      async resumeSession() {
        return session;
      },
      async stop() {
        return [];
      },
      async forceStop() {},
    },
    { ...input, provider: "copilot", outputSchema: schema, resumeSessionId },
    () => {},
  );
  return received;
}

for (const resumeSessionId of [undefined, "review-session"]) {
  test(`Copilot accepts the review integer schema in ${resumeSessionId ? "resumed" : "fresh"} sessions`, async () => {
    const schema = z.toJSONSchema(reviewSchema);
    const original = structuredClone(schema);
    const expected = structuredClone(schema);
    const findings = expected.properties?.findings;
    assert.ok(findings && typeof findings === "object");
    const finding = findings.items;
    assert.ok(
      finding && typeof finding === "object" && !Array.isArray(finding),
    );
    assert.ok(finding.properties);
    finding.properties.line = {
      anyOf: [{ type: "integer" }, { type: "null" }],
      default: null,
    };
    assert.deepEqual(
      await copilotResponseSchema(schema, resumeSessionId),
      expected,
    );
    assert.deepEqual(schema, original);
  });
}

test("Copilot normalizes integer schemas without rewriting properties or literal data", async () => {
  const bounded = {
    type: "integer",
    minimum: 1,
    maximum: 10,
    exclusiveMinimum: 0,
    exclusiveMaximum: 11,
    multipleOf: 1,
  };
  const integer = { type: "integer", multipleOf: 1 };
  const literal = { type: "integer", minimum: 2, maximum: 3 };
  const schema = {
    type: "object",
    properties: {
      minimum: bounded,
      maximum: { type: "number", minimum: 0, maximum: 1 },
      exclusiveMinimum: {
        type: "array",
        items: { anyOf: [bounded, { type: "null" }] },
      },
      exclusiveMaximum: { type: ["integer", "null"], minimum: 1, maximum: 5 },
      tuple: { type: "array", prefixItems: [bounded], items: false },
      ref: { $ref: "#/$defs/line" },
    },
    $defs: { line: bounded },
    allOf: [{ properties: { line: bounded } }],
    additionalProperties: false,
    required: ["minimum"],
    default: literal,
    examples: [literal],
    const: literal,
    enum: [literal],
    description: "Keep application bounds in local validation",
  };
  const original = structuredClone(schema);
  assert.deepEqual(await copilotResponseSchema(schema), {
    ...schema,
    properties: {
      ...schema.properties,
      minimum: integer,
      exclusiveMinimum: {
        type: "array",
        items: { anyOf: [integer, { type: "null" }] },
      },
      exclusiveMaximum: { type: ["integer", "null"] },
      tuple: { type: "array", prefixItems: [integer], items: false },
    },
    $defs: { line: integer },
    allOf: [{ properties: { line: integer } }],
  });
  assert.deepEqual(schema, original);
});

for (const [keyword, nested, normalized] of [
  ["oneOf", [{ type: "integer", minimum: 1 }], [{ type: "integer" }]],
  [
    "additionalProperties",
    { type: "integer", maximum: 9 },
    { type: "integer" },
  ],
  [
    "patternProperties",
    { "^line": { type: "integer", minimum: 1 } },
    { "^line": { type: "integer" } },
  ],
  ["not", { type: "integer", exclusiveMaximum: 3 }, { type: "integer" }],
] as const) {
  test(`Copilot normalizes integer bounds inside ${keyword}`, async () => {
    assert.deepEqual(await copilotResponseSchema({ [keyword]: nested }), {
      [keyword]: normalized,
    });
  });
}
