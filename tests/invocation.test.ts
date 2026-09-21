import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { stageSchema } from "../src/config.js";
import type {
  AgentAdapter,
  AgentInvocation,
  RunRecord,
} from "../src/domain.js";
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
      await assert.rejects(invokeStage(setup.input));
    } finally {
      clearInterval(keepAlive);
    }
    assert.equal(calls, 1);
    assert.equal(setup.records[0]?.outcome, "failed");
  }
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
