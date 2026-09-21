import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "ink-testing-library";
import React from "react";
import type { Outcome, RunRecord } from "../src/domain.js";
import {
  createTerminalNotificationWriter,
  type ExecutionNotification,
  type ExecutionNotificationWriter,
  Monitor,
} from "../src/tui/index.js";
import { monitorFixture, until } from "./tui-fixtures.js";

const size = { columns: 160, rows: 48 };
const terminalOutcomes: Outcome[] = [
  "completed",
  "failed",
  "blocked",
  "cancelled",
  "no-change",
  "ineligible",
];

function recorder(notifications: ExecutionNotification[]) {
  return {
    notify(notification) {
      notifications.push(notification);
    },
  } satisfies ExecutionNotificationWriter;
}

test("notifications are opt-in and the first successful snapshot is silent", async () => {
  const disabledFixture = monitorFixture();
  disabledFixture.run.outcome = "completed";
  disabledFixture.run.executions![0]!.outcome = "completed";
  const disabled = render(
    React.createElement(Monitor, { source: disabledFixture.source, size }),
  );
  try {
    await until(() => disabled.lastFrame()!.includes("Database connected"));
    assert.doesNotMatch(disabled.lastFrame()!, /Notifications enabled/);
  } finally {
    disabled.unmount();
  }

  const enabledFixture = monitorFixture();
  enabledFixture.run.outcome = "completed";
  enabledFixture.run.executions![0]!.outcome = "completed";
  const notifications: ExecutionNotification[] = [];
  const enabled = render(
    React.createElement(Monitor, {
      source: enabledFixture.source,
      size,
      notificationWriter: recorder(notifications),
    }),
  );
  try {
    await until(() => enabled.lastFrame()!.includes("Database connected"));
    assert.match(
      enabled.lastFrame()!,
      /Notifications enabled; delivery is best-effort and depends on terminal settings/,
    );
    assert.deepEqual(notifications, []);
  } finally {
    enabled.unmount();
  }
});

test("each terminal outcome notifies once after a nonterminal transition", async () => {
  const { source, run } = monitorFixture();
  run.executions = terminalOutcomes.map((_, index) => ({
    ...run.executions![0]!,
    id: `execution-${index}`,
    ...(index === 1 ? { recoveryOf: "execution-0" } : {}),
  }));
  const notifications: ExecutionNotification[] = [];
  const view = render(
    React.createElement(Monitor, {
      source,
      size,
      notificationWriter: recorder(notifications),
    }),
  );
  try {
    await until(() => view.lastFrame()!.includes("Database connected"));
    run.executions.forEach((execution, index) => {
      execution.outcome = terminalOutcomes[index]!;
    });
    await until(() => notifications.length === terminalOutcomes.length);
    assert.deepEqual(
      notifications,
      terminalOutcomes.map((outcome) => ({
        project: "demo",
        issue: "#1",
        outcome,
      })),
    );
    await new Promise((resolve) => setTimeout(resolve, 850));
    assert.equal(notifications.length, terminalOutcomes.length);
  } finally {
    view.unmount();
  }
});

test("unseen terminal executions notify across projects and after reconnection", async () => {
  const { source, run } = monitorFixture();
  const other: RunRecord = {
    ...run,
    id: "other-run",
    projectId: "other-project",
    issue: { ...run.issue, number: 22, title: "Private other title" },
    executions: [
      {
        ...run.executions![0]!,
        id: "other-execution",
      },
    ],
  };
  let runs = [run, other];
  let disconnected = false;
  source.projects = async () => {
    if (disconnected) throw new Error("offline");
    return [
      { id: "demo", paused: false, blocked: null },
      { id: "other-project", paused: false, blocked: null },
    ];
  };
  source.runs = async () => runs;
  const notifications: ExecutionNotification[] = [];
  const view = render(
    React.createElement(Monitor, {
      source,
      size,
      notificationWriter: recorder(notifications),
    }),
  );
  try {
    await until(() => view.lastFrame()!.includes("Database connected"));
    other.executions![0]!.outcome = "completed";
    await until(() => notifications.length === 1);
    disconnected = true;
    await until(() => view.lastFrame()!.includes("Connection error"));
    runs = [
      run,
      other,
      {
        ...other,
        id: "recovery-run",
        issue: { ...other.issue, number: 23 },
        executions: [
          {
            ...other.executions![0]!,
            id: "recovery-execution",
            recoveryOf: "other-execution",
            outcome: "failed",
          },
        ],
      },
    ];
    disconnected = false;
    await until(() => notifications.length === 2);
    assert.deepEqual(notifications, [
      { project: "other-project", issue: "#22", outcome: "completed" },
      { project: "other-project", issue: "#23", outcome: "failed" },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 850));
    assert.equal(notifications.length, 2);
    assert.match(view.lastFrame()!, /Database connected/);
  } finally {
    view.unmount();
  }
});

test("notification writer failures remain advisory", async () => {
  const { source, run } = monitorFixture();
  const writer: ExecutionNotificationWriter = {
    notify() {
      throw new Error("terminal unavailable");
    },
  };
  const view = render(
    React.createElement(Monitor, { source, size, notificationWriter: writer }),
  );
  try {
    await until(() => view.lastFrame()!.includes("Database connected"));
    run.executions![0]!.outcome = "completed";
    run.outcome = "completed";
    await until(() => view.lastFrame()!.includes("completed"));
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.match(view.lastFrame()!, /Database connected/);
    assert.doesNotMatch(view.lastFrame()!, /terminal unavailable/);
  } finally {
    view.unmount();
  }
});

test("terminal writer sanitizes and encodes plain OSC 9", () => {
  const writes: string[] = [];
  const writer = createTerminalNotificationWriter({
    write: (value) => writes.push(value),
    tmux: false,
  });
  writer.notify({
    project: "demo\u001b]9;injected\n project",
    issue: "#1\u0085private",
    outcome: "completed",
  });
  assert.deepEqual(writes, [
    "\u001b]9;agent-workflows: demo]9;injected project · #1private · completed\u001b\\",
  ]);
});

test("terminal writer wraps tmux passthrough and truncates valid UTF-8", () => {
  const writes: string[] = [];
  const writer = createTerminalNotificationWriter({
    write: (value) => writes.push(value),
    tmux: true,
  });
  writer.notify({
    project: `private-${"界".repeat(100)}`,
    issue: "#9",
    outcome: "blocked",
  });
  assert.equal(writes.length, 1);
  assert.ok(writes[0]!.startsWith("\u001bPtmux;\u001b\u001b]9;"));
  assert.ok(writes[0]!.endsWith("\u001b\u001b\\\u001b\\"));
  const payload = writes[0]!
    .slice(
      "\u001bPtmux;\u001b\u001b]9;".length,
      -"\u001b\u001b\\\u001b\\".length,
    )
    .replaceAll("\u001b\u001b", "\u001b");
  assert.ok(Buffer.byteLength(payload, "utf8") <= 256);
  assert.equal(Buffer.from(payload, "utf8").toString("utf8"), payload);
  assert.match(payload, /^agent-workflows: private-/);
  assert.doesNotMatch(payload, /#9|blocked/);
});
