import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "ink-testing-library";
import { Monitor, type MonitorSource } from "../src/tui.js";

const delay = () => new Promise((resolve) => setTimeout(resolve, 100));
test("monitor exposes keyboard selection, sessions and pending action state", async () => {
  const requests: string[] = [];
  let actionComplete = false;
  let paused = false;
  const source: MonitorSource = {
    projects: async () => [{ id: "demo", paused, blocked: null }],
    runs: async () => [
      {
        id: "run",
        projectId: "demo",
        checkout: "/fixture",
        taskKey: "task",
        attempt: 1,
        issue: {
          id: "1",
          number: 1,
          title: "Implement feature",
          body: "",
          url: "",
          labels: [],
          open: true,
        },
        outcome: "running",
        phase: "implementation",
        createdAt: "",
        updatedAt: "",
        branch: "agent/1",
      },
    ],
    invocations: async () => [
      {
        id: "inv",
        runId: "run",
        projectId: "demo",
        step: "implementation",
        stepId: 2,
        attempt: 1,
        provider: "codex",
        sessionId: "session-123",
        sessionState: "available",
        requested: { model: "requested" },
        effective: { model: "effective" },
        prompt: "",
        skills: [],
        outcome: "running",
        startedAt: "",
        log: "/tmp/fixture.log",
      },
    ],
    events: async () => [
      {
        sequence: 1,
        runId: "run",
        kind: "step",
        payload: { name: "implementation", status: "running", attempt: 1 },
        createdAt: "",
      },
      {
        sequence: 2,
        runId: "run",
        kind: "step",
        payload: { name: "validation", status: "completed", attempt: 1 },
        createdAt: "",
      },
    ],
    commands: async () =>
      actionComplete
        ? [
            {
              id: "command",
              kind: "pause",
              target: "demo",
              status: "failed",
              error: "controlled failure",
            },
          ]
        : [],
    request: async (kind, target) => {
      requests.push(`${kind}:${target}`);
      return "command";
    },
  };
  const view = render(<Monitor source={source} />);
  try {
    await delay();
    await delay();
    assert.match(view.lastFrame()!, /session-123/);
    assert.match(view.lastFrame()!, /requested/);
    view.stdin.write("]");
    await delay();
    assert.match(view.lastFrame()!, /validation/);
    view.stdin.write("p");
    await delay();
    assert.deepEqual(requests, ["pause:demo"]);
    assert.match(view.lastFrame()!, /pause: pending/);
    actionComplete = true;
    paused = true;
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.match(view.lastFrame()!, /pause: failed/);
    assert.match(view.lastFrame()!, /intake paused/);
    view.stdin.write("q");
    await delay();
    assert.deepEqual(requests, ["pause:demo"]);
  } finally {
    view.unmount();
  }
});
