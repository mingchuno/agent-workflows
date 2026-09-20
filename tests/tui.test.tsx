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
    actionComplete = false;
    view.stdin.write("c");
    await delay();
    assert.deepEqual(requests, ["pause:demo", "recover:run"]);
    assert.match(view.lastFrame()!, /recover: pending/);
    view.stdin.write("q");
    await delay();
    assert.deepEqual(requests, ["pause:demo", "recover:run"]);
  } finally {
    view.unmount();
  }
});

test("monitor resets dependent selections while a command is pending and ignores stale run data", async () => {
  const baseRun = {
    checkout: "/fixture",
    taskKey: "task",
    attempt: 1,
    issue: {
      id: "1",
      number: 1,
      title: "Task",
      body: "",
      url: "",
      labels: [],
      open: true,
    },
    outcome: "running" as const,
    phase: "implementation",
    createdAt: "",
    updatedAt: "",
    branch: "agent/1",
  };
  const runs = [
    { ...baseRun, id: "a1", projectId: "alpha" },
    { ...baseRun, id: "a2", projectId: "alpha" },
    { ...baseRun, id: "b1", projectId: "beta" },
  ];
  const sessions = (runId: string) =>
    [0, 1].map((index) => ({
      id: `${runId}-${index}`,
      runId,
      projectId: runId.startsWith("a") ? "alpha" : "beta",
      step: "implementation",
      stepId: index,
      attempt: 1,
      provider: "codex",
      sessionId: `${runId}-session-${index}`,
      sessionState: "available" as const,
      requested: {},
      effective: {},
      prompt: "",
      skills: [],
      outcome: "running",
      startedAt: "",
      log: "/unused",
    }));
  let resolveRequest!: (id: string) => void;
  const request = new Promise<string>((resolve) => {
    resolveRequest = resolve;
  });
  let resolveStale!: (value: ReturnType<typeof sessions>) => void;
  let delayAlpha = false;
  let staleStarted = false;
  let commandComplete = false;
  const requests: string[] = [];
  const source: MonitorSource = {
    projects: async () =>
      ["alpha", "beta"].map((id) => ({ id, paused: false, blocked: null })),
    runs: async () => runs,
    invocations: async (runId) => {
      if (runId === "a1" && delayAlpha) {
        staleStarted = true;
        return new Promise((resolve) => {
          resolveStale = resolve;
        });
      }
      return sessions(runId);
    },
    events: async (_after, runId) =>
      [0, 1].map((index) => ({
        sequence: index + 1,
        runId: runId!,
        kind: "step",
        payload: { name: `${runId}-step-${index}` },
        createdAt: "",
      })),
    request: async (kind, target) => {
      requests.push(`${kind}:${target}`);
      return request;
    },
    commands: async () => [
      {
        id: "command",
        kind: "pause",
        target: "alpha",
        status: commandComplete ? "success" : "pending",
        error: null,
      },
    ],
  };
  const view = render(<Monitor source={source} />);
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, view.lastFrame() ?? "No frame");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  try {
    await until(() => view.lastFrame()!.includes("a1-session-0"));
    view.stdin.write("\t");
    view.stdin.write("]");
    await until(
      () =>
        view.lastFrame()!.includes("a1-session-1") &&
        view.lastFrame()!.includes("a1-step-1"),
    );
    delayAlpha = true;
    view.stdin.write("p");
    await until(() => staleStarted);
    view.stdin.write("\u001b[B");
    await until(
      () =>
        view.lastFrame()!.includes("a2-session-0") &&
        view.lastFrame()!.includes("a2-step-0"),
    );
    view.stdin.write("\t");
    view.stdin.write("]");
    await until(() => view.lastFrame()!.includes("a2-session-1"));
    view.stdin.write("\u001b[C");
    await until(
      () =>
        view.lastFrame()!.includes("b1-session-0") &&
        view.lastFrame()!.includes("b1-step-0"),
    );
    resolveStale(sessions("a1"));
    await delay();
    assert.match(view.lastFrame()!, /b1-session-0/);
    assert.match(view.lastFrame()!, /pause: pending/);
    view.stdin.write("r");
    await delay();
    assert.deepEqual(requests, ["pause:alpha"]);
    resolveRequest("command");
    commandComplete = true;
    await until(() => view.lastFrame()!.includes("pause: success"));
  } finally {
    resolveRequest("command");
    resolveStale?.(sessions("a1"));
    view.unmount();
  }
});
