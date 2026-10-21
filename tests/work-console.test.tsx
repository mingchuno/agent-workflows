import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "ink-testing-library";
import stringWidth from "string-width";
import { Monitor } from "../packages/cli/src/tui/index.js";
import { WorkItemsView } from "../packages/cli/src/tui/work-items.js";
import type {
  MonitorWorkItem,
  WorkApproval,
} from "../packages/cli/src/web/contracts.js";
import { workContractSchema } from "../packages/core/src/work/schema.js";
import { monitorFixture, settle, until } from "./tui-fixtures.js";

function workItem(): MonitorWorkItem {
  return {
    work: {
      id: "work-one",
      projectId: "demo",
      source: { kind: "local", key: "sort" },
      contract: workContractSchema.parse({
        title: "Sort missing sizes",
        intent: "Missing sizes sort last",
        acceptanceCriteria: ["Missing sizes follow numbers"],
        scopePaths: ["src/**"],
        verification: { strategy: "Regression test" },
        assessment: { proposedTrack: "B", complexity: "moderate" },
      }),
      revision: "1".repeat(64),
      createdAt: "2026-10-21T00:00:00Z",
      updatedAt: "2026-10-21T00:00:00Z",
    },
    approvals: [],
    decision: {
      track: "B",
      state: "awaiting-scope-approval",
      reasons: [
        { code: "approval", message: "Current scope approval is required" },
      ],
      requiredGates: ["scope"],
    },
    approvalSource: "local-operator",
    runIds: [],
  };
}

test("terminal monitor opens Work Items and approval starts on Cancel", async () => {
  const { source } = monitorFixture();
  const item = workItem();
  const approvals: Array<{ id: string; approval: WorkApproval }> = [];
  source.workItems = async () => [item];
  source.approveWork = async (id, approval) => {
    approvals.push({ id, approval });
    item.decision = { ...item.decision, state: "ready", reasons: [] };
    return item;
  };
  const view = render(
    <Monitor source={source} size={{ columns: 120, rows: 30 }} />,
  );
  try {
    await until(() => view.lastFrame()!.includes("Database connected"));
    view.stdin.write("w");
    await until(() => view.lastFrame()!.includes("Sort missing sizes"));
    assert.match(view.lastFrame()!, /awaiting-scope-approval/);
    assert.match(
      view.lastFrame()!,
      /1111111111111111111111111111111111111111111111111111111111111111/,
    );
    view.stdin.write("a");
    await until(() => view.lastFrame()!.includes("Approve scope"));
    view.stdin.write("\r");
    await until(() => view.lastFrame()!.includes("Work Items / demo"));
    assert.deepEqual(approvals, []);
    view.stdin.write("a");
    await until(() => view.lastFrame()!.includes("Approve scope"));
    view.stdin.write("\t");
    await settle();
    view.stdin.write("\r");
    await until(() => view.lastFrame()!.includes("Recorded scope approval"));
    assert.deepEqual(approvals, [
      { id: "work-one", approval: { gate: "scope", revision: "1".repeat(64) } },
    ]);
    view.stdin.write("\u001b");
    await until(() =>
      view.lastFrame()!.includes("Agent Workflows / demo / Monitor"),
    );
  } finally {
    view.unmount();
  }
});

test("terminal confirmation rejects a Work Item changed during inspection", async () => {
  const { source } = monitorFixture();
  let item = workItem();
  let approvals = 0;
  source.workItems = async () => [item];
  source.approveWork = async () => {
    approvals++;
    return item;
  };
  const view = render(
    <WorkItemsView
      source={source}
      projectId="demo"
      columns={100}
      rows={28}
      onClose={() => {}}
    />,
  );
  try {
    await until(() => view.lastFrame()!.includes("Sort missing sizes"));
    view.stdin.write("a");
    await until(() => view.lastFrame()!.includes("Approve scope"));
    item = {
      ...item,
      work: {
        ...item.work,
        revision: "2".repeat(64),
        contract: { ...item.work.contract, intent: "Sort missing sizes first" },
      },
    };
    await until(() => view.lastFrame()!.includes("no longer available"));
    view.stdin.write("\t");
    await settle();
    view.stdin.write("\r");
    await settle();
    assert.equal(approvals, 0);
    view.stdin.write("\u001b");
    await until(() =>
      view
        .lastFrame()!
        .includes(
          "2222222222222222222222222222222222222222222222222222222222222222",
        ),
    );
    for (const frame of view.frames) {
      assert.ok(frame.split("\n").length <= 28, frame);
      assert.ok(
        frame.split("\n").every((line) => stringWidth(line) <= 100),
        frame,
      );
    }
  } finally {
    view.unmount();
  }
});

test("terminal Work Items cannot locally approve enterprise gates", async () => {
  const { source } = monitorFixture();
  const item = { ...workItem(), approvalSource: "gitlab" as const };
  let approvals = 0;
  source.workItems = async () => [item];
  source.approveWork = async () => {
    approvals++;
    return item;
  };
  const view = render(
    <WorkItemsView
      source={source}
      columns={100}
      rows={28}
      onClose={() => {}}
    />,
  );
  try {
    await until(() =>
      view.lastFrame()!.includes("authenticated allowed human through gitlab"),
    );
    view.stdin.write("a");
    await settle();
    assert.equal(approvals, 0);
    assert.doesNotMatch(view.lastFrame()!, /Approve scope/);
  } finally {
    view.unmount();
  }
});
