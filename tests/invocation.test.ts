import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionConfig } from "@github/copilot-sdk";
import { z } from "zod";
import { runCopilot } from "../src/adapters/sdk-protocol.js";
import { stageSchema } from "../src/config.js";
import type {
  AgentAdapter,
  AgentInvocation,
  RunRecord,
} from "../src/domain.js";
import { publicationSchema } from "../src/domain.js";
import { captureEvidence } from "../src/evidence.js";
import { invokeStage } from "../src/invocation.js";
import type { InvocationRecord, Store } from "../src/store.js";
import { ExistingCheckout } from "../src/workspace.js";
import { repository } from "./fixtures.js";
import { agent, FixtureHosting } from "./runner-fixtures.js";

async function fixture(invoke: AgentAdapter["invoke"], timeoutMs = 5000) {
  const { project } = await repository();
  const workspace = new ExistingCheckout();
  const run = {
    id: "run",
    projectId: project.id,
    snapshot: await workspace.inspect(project),
    issue: new FixtureHosting().issues[0]!,
  } as RunRecord;
  const records: InvocationRecord[] = [];
  const controller = new AbortController();
  const store = {
    async run() {
      return run;
    },
    async patchRun(_id: string, patch: Partial<RunRecord>) {
      Object.assign(run, patch);
      return run;
    },
    async invocations() {
      return records;
    },
    async saveInvocation(record: InvocationRecord) {
      const index = records.findIndex((item) => item.id === record.id);
      if (index === -1) records.push(structuredClone(record));
      else records[index] = structuredClone(record);
    },
  } as unknown as Store;
  const input: Parameters<typeof invokeStage>[0] = {
    run,
    name: "custom",
    stage: stageSchema.parse({ timeoutMs }),
    task: {
      defaultPrompt: "Default task",
      context: () => "Fixed issue evidence",
      readOnly: true,
      outputContract: z.strictObject({ result: z.string() }),
    },
    stepId: 1,
    dependencies: {
      project,
      workspace,
      store,
      hosting: new FixtureHosting(),
      agents: { codex: { ...agent, invoke } },
      artifacts: await mkdtemp(join(tmpdir(), "invocation-")),
      signal: controller.signal,
      redact: (text) => text,
    },
  };
  return { input, records, controller };
}

test("cancelled or timed-out returned output never gets format correction", async () => {
  for (const reason of ["cancelled", "timeout"] as const) {
    let calls = 0;
    const setup = await fixture(
      async (invocation) => {
        calls++;
        if (reason === "cancelled") setup.controller.abort();
        else
          await new Promise((resolve) => {
            invocation.signal.addEventListener("abort", resolve, {
              once: true,
            });
          });
        return "invalid JSON";
      },
      reason === "timeout" ? 300 : 5000,
    );
    // Keep the event loop alive while waiting for AbortSignal.timeout's unref'ed timer.
    const keepAlive = setInterval(() => {}, 1000);
    try {
      if (reason === "timeout")
        await assert.rejects(
          invokeStage(setup.input),
          /custom agent stage timed out after 300 ms/,
        );
      else await assert.rejects(invokeStage(setup.input));
    } finally {
      clearInterval(keepAlive);
    }
    assert.equal(calls, 1);
    assert.equal(setup.records[0]?.outcome, "failed");
  }
});
test("preflight failure leaves a readable stage diagnostic without an invocation", async () => {
  const { input, records } = await fixture(async () => "unused");
  input.dependencies.agents.codex = {
    ...agent,
    validate: async () => {
      throw new Error("worker exited before session startup");
    },
  };
  await assert.rejects(
    invokeStage(input),
    /worker exited before session startup/,
  );
  assert.equal(records.length, 0);
  const path = input.run.stageLogs?.[0]?.path;
  assert.ok(path);
  const log = await readFile(path, "utf8");
  assert.match(log, /Validating codex agent profile/);
  assert.match(log, /worker exited before session startup/);
});
test("custom prompt overrides task only, context is frozen across response attempts", async () => {
  const calls: AgentInvocation[] = [];
  const { input, records } = await fixture(async (invocation) => {
    calls.push(invocation);
    await invocation.session(`session-${calls.length}`);
    return calls.length === 1 ? "bad" : '{"result":"ok"}';
  });
  input.stage.prompt = "Custom task";
  let contextReads = 0;
  input.task.context = () => `Context ${++contextReads}`;
  assert.equal(await invokeStage(input), '{"result":"ok"}');
  assert.equal(contextReads, 1);
  for (const call of calls) {
    assert.match(call.prompt, /Custom task/);
    assert.doesNotMatch(call.prompt, /Default task/);
    assert.match(call.prompt, /Context 1/);
    assert.match(call.prompt, /application-owned schema/);
  }
  assert.deepEqual(
    records.map((record) => record.sessionId),
    ["session-1", "session-2"],
  );
  await assert.rejects(invokeStage(input), /Interrupted agent stage/);
  assert.equal(calls.length, 2);
});
test("custom text stages return literal output without format correction", async () => {
  let calls = 0;
  const { input } = await fixture(async () => {
    calls++;
    return "plain text";
  });
  delete input.task.outputContract;
  assert.equal(await invokeStage(input), "plain text");
  assert.equal(calls, 1);
});

test("only Copilot publication and review receive captured evidence tools", async () => {
  const { EvidenceWriter } = await import("../src/evidence.js");
  const directory = await mkdtemp(join(tmpdir(), "invocation-evidence-"));
  const writer = new EvidenceWriter(directory);
  const index = await writer.index("", { changedPaths: 0 });
  const evidence = {
    index: index.path,
    identity: index.sha256,
    files: writer.files,
    changedPaths: 0,
    base: "base",
  };
  for (const name of ["publication", "review"] as const) {
    const calls: AgentInvocation[] = [];
    const setup = await fixture(async (invocation) => {
      calls.push(invocation);
      return '{"result":"ok"}';
    });
    setup.input.name = name;
    setup.input.task.evidence = evidence;
    setup.input.dependencies.project.agent.provider = "copilot";
    setup.input.dependencies.agents.copilot =
      setup.input.dependencies.agents.codex!;
    assert.equal(await invokeStage(setup.input), '{"result":"ok"}');
    assert.equal(calls[0]!.evidence, evidence);
    assert.match(calls[0]!.prompt, /evidence_list_changes/);
    assert.match(calls[0]!.prompt, /Do not request shell or write permission/);
    if (name === "review") {
      let registeredTools: string[] | undefined;
      await runCopilot(
        {
          async start() {},
          async listModels() {
            return [];
          },
          async createSession(options) {
            registeredTools = options.tools?.map((tool) => tool.name);
            return {
              sessionId: "review-session",
              on() {},
              async sendAndWait() {
                return { data: { content: "{}" } };
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
          provider: "copilot",
          operation: "invoke",
          id: calls[0]!.id,
          cwd: calls[0]!.cwd,
          prompt: calls[0]!.prompt,
          profile: calls[0]!.profile,
          readOnly: calls[0]!.readOnly,
          evidence: calls[0]!.evidence,
        },
        () => {},
      );
      assert.deepEqual(registeredTools, [
        "evidence_list_changes",
        "evidence_read_change",
        "evidence_search",
      ]);
    }
  }

  const codexCalls: AgentInvocation[] = [];
  const codex = await fixture(async (invocation) => {
    codexCalls.push(invocation);
    return '{"result":"ok"}';
  });
  codex.input.name = "publication";
  codex.input.task.evidence = evidence;
  assert.equal(await invokeStage(codex.input), '{"result":"ok"}');
  assert.equal(codexCalls[0]!.evidence, undefined);
  assert.doesNotMatch(codexCalls[0]!.prompt, /evidence_list_changes/);

  const implementationCalls: AgentInvocation[] = [];
  const implementation = await fixture(async (invocation) => {
    implementationCalls.push(invocation);
    return '{"result":"ok"}';
  });
  implementation.input.name = "implementation";
  implementation.input.task.evidence = evidence;
  implementation.input.dependencies.project.agent.provider = "copilot";
  implementation.input.dependencies.agents.copilot =
    implementation.input.dependencies.agents.codex!;
  assert.equal(await invokeStage(implementation.input), '{"result":"ok"}');
  assert.equal(implementationCalls[0]!.evidence, undefined);
  assert.doesNotMatch(implementationCalls[0]!.prompt, /evidence_list_changes/);
});

test("a Copilot publication invocation navigates multi-chunk evidence and returns valid JSON without shell approval", async () => {
  const { root, project } = await repository();
  await writeFile(
    join(root, "large.txt"),
    `${"context line\n".repeat(7_000)}publication needle\n`,
  );
  const evidence = await captureEvidence({
    project,
    directory: await mkdtemp(join(tmpdir(), "publication-evidence-")),
    snapshot: await new ExistingCheckout().inspect(project),
  });
  let sessions = 0;
  let inspectedChunks = 0;
  const output = JSON.stringify({
    commitMessage: "feat: describe captured change",
    title: "Describe captured change",
    description:
      "Inspected all captured chunks and found the publication needle.",
  });
  const setup = await fixture(async (invocation) => {
    const pending: Promise<void>[] = [];
    let result = "";
    await runCopilot(
      {
        async start() {},
        async listModels() {
          return [];
        },
        async createSession(options: SessionConfig) {
          sessions++;
          assert.deepEqual(
            options.tools?.map((tool) => tool.name),
            [
              "evidence_list_changes",
              "evidence_read_change",
              "evidence_search",
            ],
          );
          assert.ok(options.tools?.every((tool) => tool.skipPermission));
          const tools = options.tools!;
          const call = async (index: number, args: Record<string, unknown>) =>
            tools[index]!.handler!(args, {
              sessionId: "publication-session",
              toolCallId: `call-${index}-${inspectedChunks}`,
              toolName: tools[index]!.name,
              arguments: args,
            });
          return {
            sessionId: "publication-session",
            on() {},
            async sendAndWait() {
              const listed = (await call(0, { page: 1 })) as {
                changes: Array<{
                  reference: string;
                  chunks: Array<{ ordinal: number }>;
                }>;
              };
              assert.equal(listed.changes.length, 1);
              assert.ok(listed.changes[0]!.chunks.length > 1);
              const found = (await call(2, { term: "publication needle" })) as {
                matches: Array<{ reference: string }>;
              };
              assert.equal(
                found.matches[0]?.reference,
                listed.changes[0]!.reference,
              );
              for (const chunk of listed.changes[0]!.chunks) {
                const read = (await call(1, {
                  reference: listed.changes[0]!.reference,
                  chunk: chunk.ordinal,
                })) as { text: string; remainingUnreadChunks: number };
                inspectedChunks++;
                if (inspectedChunks === listed.changes[0]!.chunks.length)
                  assert.equal(read.remainingUnreadChunks, 0);
              }
              const permission = await options.onPermissionRequest!(
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
                { sessionId: "publication-session" },
              );
              assert.equal(permission.kind, "reject");
              return { data: { content: output } };
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
        provider: "copilot",
        operation: "invoke",
        id: invocation.id,
        cwd: invocation.cwd,
        prompt: invocation.prompt,
        profile: invocation.profile,
        readOnly: invocation.readOnly,
        evidence: invocation.evidence,
        outputSchema: invocation.outputSchema,
      },
      (type, value) => {
        if (type === "result") result = value as string;
        if (type === "session")
          pending.push(invocation.session(value as string));
        if (type === "event") pending.push(invocation.event(value));
      },
    );
    await Promise.all(pending);
    return result;
  });
  setup.input.name = "publication";
  setup.input.task.evidence = evidence;
  setup.input.task.outputContract = publicationSchema;
  setup.input.dependencies.project.agent.provider = "copilot";
  setup.input.dependencies.agents.copilot =
    setup.input.dependencies.agents.codex!;
  const result = await invokeStage(setup.input);
  assert.deepEqual(
    publicationSchema.parse(JSON.parse(result)),
    JSON.parse(output),
  );
  assert.equal(sessions, 1);
  assert.ok(inspectedChunks > 1);
});

for (const response of ["valid", "invalid", "throws"] as const)
  test(`final persistence failure takes precedence over ${response} output and stops correction`, async () => {
    let calls = 0;
    const { input, records } = await fixture(async () => {
      calls++;
      if (response === "throws") throw new Error("provider failure");
      return response === "valid" ? '{"result":"ok"}' : "invalid";
    });
    const save = input.dependencies.store.saveInvocation.bind(
      input.dependencies.store,
    );
    input.dependencies.store.saveInvocation = async (record) => {
      if (record.finishedAt) throw new Error("final persistence failed");
      await save(record);
    };
    await assert.rejects(invokeStage(input), /final persistence failed/);
    assert.equal(calls, 1);
    assert.equal(records[0]?.outcome, "running");
    assert.equal(records[0]?.finishedAt, undefined);
  });

test("a writable stage retains its contribution through read-only format correction", async () => {
  const calls: AgentInvocation[] = [];
  const { input, records } = await fixture(async (invocation) => {
    calls.push(invocation);
    if (calls.length === 1) {
      await writeFile(
        join(invocation.cwd, "contribution.txt"),
        "implementation",
      );
      return "invalid";
    }
    assert.equal(input.run.contributionCandidates, undefined);
    return '{"result":"ok"}';
  });
  input.task.readOnly = false;
  assert.equal(await invokeStage(input), '{"result":"ok"}');
  assert.deepEqual(
    calls.map((call) => call.readOnly),
    [false, true],
  );
  assert.equal(calls[0]!.signal, calls[1]!.signal);
  assert.ok(calls[1]!.timeoutMs! <= calls[0]!.timeoutMs!);
  assert.equal(input.run.contributionCandidates?.length, 1);
  const candidate = input.run.contributionCandidates![0]!;
  assert.equal(candidate.provider, "codex");
  assert.equal(candidate.beforeFiles["contribution.txt"], undefined);
  assert.equal(
    candidate.afterFiles["contribution.txt"],
    input.run.snapshot!.files["contribution.txt"],
  );
  assert.deepEqual(
    records.map((record) => record.outcome),
    ["invalid-output", "completed"],
  );
});
