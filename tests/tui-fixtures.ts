import assert from "node:assert/strict";
import type { RunRecord } from "../src/domain.js";
import type { InvocationRecord } from "../src/store.js";
import type { MonitorSource } from "../src/tui/index.js";

export function monitorFixture() {
  const run: RunRecord = {
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
    createdAt: "2026-09-20T10:00:00Z",
    updatedAt: "2026-09-20T10:01:00Z",
    branch: "agent/1",
    executions: [
      {
        id: "run",
        createdAt: "2026-09-20T10:00:00Z",
        startedAt: "2026-09-20T10:00:01Z",
        fingerprint: "",
        recoverySupported: true,
        outcome: "running",
        phase: "implementation",
      },
    ],
  };
  const requests: string[] = [];
  const sessions: InvocationRecord[] = [
    {
      id: "inv",
      runId: "run",
      projectId: "demo",
      step: "implementation",
      stepId: 2,
      attempt: 1,
      provider: "codex",
      sessionId: "session-123",
      sessionState: "available" as const,
      requested: { model: "requested" },
      effective: { model: "effective" },
      prompt: "",
      skills: [],
      outcome: "running",
      startedAt: "2026-09-20T10:00:01Z",
      log: "/missing/fixture.log",
    },
  ];
  const source: MonitorSource = {
    projects: async () => [{ id: "demo", paused: false, blocked: null }],
    runs: async () => [run],
    invocations: async () => sessions,
    events: async (after = 0) =>
      [
        {
          sequence: 1,
          runId: "run",
          kind: "step",
          payload: { name: "implementation", status: "running", attempt: 1 },
          createdAt: "",
        },
      ].filter((event) => event.sequence > after),
    commands: async () => [],
    request: async (kind, target) => {
      requests.push(`${kind}:${target}`);
      return "command";
    },
  };
  return { run, requests, sessions, source };
}
export async function until(
  predicate: () => boolean,
  frame: () => string | undefined = () => "Condition did not become true",
) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, frame() ?? "No frame");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
export const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
