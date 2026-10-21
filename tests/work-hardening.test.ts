import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionConfig } from "@github/copilot-sdk";
import {
  inspectionTool,
  mayReadPath,
} from "../packages/core/src/adapters/inspection.js";
import {
  type CopilotClientContract,
  runCodex,
  runCopilot,
  type WorkerInput,
} from "../packages/core/src/adapters/sdk-protocol.js";
import { projectSchema } from "../packages/core/src/config.js";
import { createQueuedWorkRun } from "../packages/core/src/run-record.js";
import { Store } from "../packages/core/src/store.js";
import { syncWorkApprovals } from "../packages/core/src/work/approvals.js";
import { workContractSchema } from "../packages/core/src/work/schema.js";
import { issueSource } from "../packages/core/src/work/store.js";
import { repository } from "./fixtures.js";
import { FixtureHosting } from "./runner-fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
for (const provider of ["github", "gitlab"] as const) {
  test(`${provider} imports only allowlisted human approval of the current revision`, {
    skip: !databaseUrl,
  }, async () => {
    const project = projectSchema.parse({
      id: "project",
      checkout: "/tmp",
      hosting: {
        provider,
        origin: "https://example.test",
        repository: "a/b",
        tokenEnv: "TOKEN",
      },
      agent: { provider: "codex" },
      sdlc: {
        enabled: true,
        approvalSource: provider,
        approvers: ["allowed-human"],
      },
    });
    const store = new Store(databaseUrl!, randomUUID());
    const hosting = new FixtureHosting();
    const comments: Awaited<
      ReturnType<NonNullable<typeof hosting.listApprovalComments>>
    > = [];
    hosting.listApprovalComments = async () => comments;
    try {
      await store.initialize();
      await store.registerProject(project.id);
      const work = await store.workItems.create(
        project.id,
        issueSource(provider, hosting.issues[0]!),
        {
          title: "Add file",
          intent: "Add requested file",
          acceptanceCriteria: ["File exists"],
          scopePaths: ["implemented.txt"],
          verification: { strategy: "Regression test" },
          assessment: { proposedTrack: "B", complexity: "small" },
        },
      );
      const body = `agent-workflows approve ${work.id} scope ${work.revision}`;
      const comment = {
        id: "1",
        body,
        author: "allowed-human",
        human: true,
        url: "https://example.test/issue/1#comment-1",
      };
      comments.push(
        { ...comment, author: "outsider" },
        { ...comment, human: false },
        { ...comment, body: body.replace(work.revision, "a".repeat(64)) },
      );
      assert.equal(
        await syncWorkApprovals(work.id, project, store, hosting),
        0,
      );
      await assert.rejects(
        store.workItems.submit(work.id, work.revision, project),
        /scope approval/,
      );
      comments.push(comment);
      assert.equal(
        await syncWorkApprovals(work.id, project, store, hosting),
        1,
      );
      assert.equal(
        await syncWorkApprovals(work.id, project, store, hosting),
        0,
      );
      assert.equal(
        (await store.workItems.inspect(work.id, project)).decision.state,
        "ready",
      );
      const [approval] = await store.workItems.approvals(work.id);
      assert.equal(approval?.approvedBy, "allowed-human");
      assert.equal(approval?.source, provider);
      assert.equal(approval?.evidence, comment.url);
      hosting.issues[0]!.body = "Edited after human approved";
      await assert.rejects(
        syncWorkApprovals(work.id, project, store, hosting),
        /Source changed/,
      );
    } finally {
      await store.close();
    }
  });
}

const workerInput: WorkerInput = {
  provider: "codex",
  operation: "invoke",
  id: "test",
  cwd: process.cwd(),
  prompt: "Review",
  profile: { provider: "codex" },
  permissionMode: "read-only",
};
test("Codex restricted stages request read-only sandbox and disable network search", async () => {
  await runCodex(
    {
      startThread(options) {
        assert.equal(options.sandboxMode, "read-only");
        assert.equal(options.networkAccessEnabled, false);
        assert.equal(options.webSearchMode, "disabled");
        assert.equal(options.approvalPolicy, "never");
        return {
          async runStreamed() {
            return {
              events: (async function* () {
                yield {
                  type: "turn.completed" as const,
                  usage: {
                    input_tokens: 0,
                    output_tokens: 0,
                    cached_input_tokens: 0,
                    cache_write_input_tokens: 0,
                    reasoning_output_tokens: 0,
                  },
                };
              })(),
            };
          },
        };
      },
      resumeThread() {
        throw new Error("Fresh session required");
      },
    },
    workerInput,
    () => {},
  );
});

test("Copilot restricted stages deny shell, mutation, network and unregistered tools", async () => {
  let configuration: SessionConfig | undefined;
  const client: CopilotClientContract = {
    async start() {},
    async listModels() {
      return [];
    },
    async createSession(options) {
      configuration = options;
      return {
        sessionId: "test",
        on() {},
        async sendAndWait() {
          return { data: { content: "review" } };
        },
        async disconnect() {},
      };
    },
    async resumeSession() {
      throw new Error("Fresh session required");
    },
    async stop() {
      return [];
    },
    async forceStop() {},
  };
  await runCopilot(
    client,
    { ...workerInput, provider: "copilot", profile: { provider: "copilot" } },
    () => {},
  );
  assert.ok(configuration);
  assert.equal(configuration.enableConfigDiscovery, false);
  assert.deepEqual(configuration.availableTools, [
    "view",
    "read_file",
    "glob",
    "grep",
    "inspect_git",
  ]);
  const permission = configuration.onPermissionRequest!;
  assert.equal(
    (
      await permission(
        {
          kind: "read",
          path: join(process.cwd(), "package.json"),
          intention: "inspect",
        },
        { sessionId: "test" },
      )
    ).kind,
    "approve-once",
  );
  assert.equal(
    (
      await permission(
        { kind: "read", path: "/etc/passwd", intention: "inspect" },
        { sessionId: "test" },
      )
    ).kind,
    "reject",
  );
  assert.equal(
    (
      await permission(
        {
          kind: "write",
          fileName: join(process.cwd(), "package.json"),
          intention: "mutate",
          canOfferSessionApproval: false,
          diff: "fixture",
        },
        { sessionId: "test" },
      )
    ).kind,
    "reject",
  );
  const hook = configuration.hooks?.onPreToolUse;
  assert.ok(hook);
  for (const toolName of [
    "bash",
    "edit",
    "create",
    "web_fetch",
    "mcp_external",
  ]) {
    const decision = await hook(
      {
        toolName,
        toolArgs: {},
        timestamp: new Date(),
        sessionId: "test",
        workingDirectory: process.cwd(),
      },
      { sessionId: "test" },
    );
    assert.equal(decision?.permissionDecision, "deny");
  }
});

test("restricted Git inspection returns the real diff and rejects traversal", async () => {
  const { root, git } = await repository();
  const base = (await git("rev-parse", "HEAD")).stdout.trim();
  await writeFile(join(root, "file.txt"), "changed\n");
  const tool = inspectionTool(root, base);
  assert.ok(tool.handler);
  const result = await tool.handler({ operation: "diff" }, {} as never);
  assert.match(String(result), /-base\n\+changed/);
  await assert.rejects(
    async () =>
      tool.handler!({ operation: "show-base", path: "../secret" }, {} as never),
    /repository-relative/,
  );
  assert.equal(await mayReadPath(root, "file.txt"), true);
  assert.equal(await mayReadPath(root, "../secret"), false);
});

test("Track C host approval imports scope before design regardless of note order", {
  skip: !databaseUrl,
}, async () => {
  const { project } = await repository();
  project.sdlc = {
    ...project.sdlc,
    enabled: true,
    approvalSource: "github",
    approvers: ["human"],
  };
  const hosting = new FixtureHosting();
  const store = new Store(databaseUrl!, randomUUID());
  try {
    await store.initialize();
    const contract = workContractSchema.parse({
      title: "Controlled work",
      intent: "Change a contract",
      acceptanceCriteria: ["Expected contract is present"],
      scopePaths: ["src/**"],
      assessment: { proposedTrack: "C", complexity: "small" },
      verification: { strategy: "Contract checks" },
      design: {
        summary: "Change the contract",
        stages: ["Update API"],
        verification: "Run contract checks",
        rollback: "Revert API change",
      },
    });
    const work = await store.workItems.create(
      project.id,
      issueSource("github", hosting.issues[0]!),
      contract,
    );
    hosting.listApprovalComments = async () =>
      ["design", "scope", "scope"].map((gate, index) => ({
        id: String(index),
        body: `agent-workflows approve ${work.id} ${gate} ${work.revision}`,
        author: "human",
        human: true,
        url: `https://example.test/comment/${index}`,
      }));
    assert.equal(await syncWorkApprovals(work.id, project, store, hosting), 2);
    assert.equal(
      (await store.workItems.inspect(work.id, project)).decision.state,
      "ready",
    );
    assert.equal(await syncWorkApprovals(work.id, project, store, hosting), 0);
  } finally {
    await store.close();
  }
});

test("custom work branch templates use each Run identity", async () => {
  const { project } = await repository();
  project.branchTemplate = "agent/{issue}-{run}";
  const contract = workContractSchema.parse({
    title: "Task",
    intent: "Do task",
    acceptanceCriteria: ["Done"],
  });
  const work = {
    id: "work-id",
    projectId: project.id,
    source: { kind: "local" as const, key: "task" },
    contract,
    revision: "one",
    createdAt: "2026-10-21T00:00:00Z",
    updatedAt: "2026-10-21T00:00:00Z",
  };
  const first = createQueuedWorkRun(work, project);
  const second = createQueuedWorkRun({ ...work, revision: "two" }, project, 2);
  assert.equal(first.branch, `agent/work-id-${first.id}`);
  assert.equal(second.branch, `agent/work-id-${second.id}`);
  assert.notEqual(first.branch, second.branch);
});
