import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
