import assert from "node:assert/strict";
import { test } from "node:test";
import type { MonitorSnapshot } from "../src/web/contracts.js";
import {
  commandNotice,
  commandPending,
  transitionCommand,
} from "../web/command-lifecycle.js";
import { type LogNavigation, navigateLog } from "../web/log-navigation.js";
import { selectMonitorRuns } from "../web/selection.js";
import { monitorFixture } from "./tui-fixtures.js";

test("log navigation preserves search position and repeat request identity", () => {
  let state: LogNavigation = { mode: "follow" };
  state = navigateLog(state, {
    type: "search",
    query: "needle",
    direction: "next",
    page: { start: 20 },
  });
  assert.deepEqual(state, {
    mode: "search",
    start: undefined,
    search: { query: "needle", direction: "next", from: 20, request: 1 },
  });
  state = navigateLog(state, {
    type: "search",
    query: "needle",
    direction: "previous",
    page: { start: 30, match: 35 },
  });
  assert.deepEqual(state, {
    mode: "search",
    start: undefined,
    search: { query: "needle", direction: "previous", from: 35, request: 2 },
  });
  state = navigateLog(state, {
    type: "search",
    query: "absent",
    direction: "next",
    page: { start: 30 },
  });
  assert.equal(state.mode === "search" && state.search.from, 30);
});

test("paging clears search and resuming follow clears the pinned position", () => {
  const searched = navigateLog(
    { mode: "page", start: 200 },
    { type: "search", query: "needle", direction: "next" },
  );
  assert.equal(searched.mode === "search" && searched.start, 200);
  const beginning = navigateLog(searched, { type: "move", start: -200 });
  assert.deepEqual(beginning, { mode: "page", start: 0 });
  const following = navigateLog(beginning, {
    type: "toggle-follow",
    pageStart: 0,
  });
  assert.deepEqual(following, { mode: "follow" });
  assert.deepEqual(
    navigateLog(following, { type: "toggle-follow", pageStart: 85 }),
    { mode: "page", start: 85 },
  );
});

test("commands remain pending until the matching runner acknowledgement", () => {
  const submitted = transitionCommand(
    { phase: "idle" },
    { type: "submit", kind: "stop" },
  );
  assert.equal(commandPending(submitted), true);
  assert.equal(
    transitionCommand(submitted, { type: "submit", kind: "reload" }),
    submitted,
  );
  const awaiting = transitionCommand(submitted, {
    type: "accepted",
    id: "command-1",
  });
  assert.equal(commandPending(awaiting), true);
  assert.equal(
    commandNotice(awaiting),
    "stop: pending — waiting for runner acknowledgement",
  );
  assert.equal(
    transitionCommand(awaiting, { type: "submit", kind: "reload" }),
    awaiting,
  );
  const command: MonitorSnapshot["commands"][number] = {
    id: "command-1",
    kind: "stop",
    target: "run-1",
    status: "pending",
    error: null,
  };
  assert.equal(
    transitionCommand(awaiting, { type: "acknowledged", command }),
    awaiting,
  );
  assert.equal(
    transitionCommand(awaiting, {
      type: "acknowledged",
      command: { ...command, id: "other", status: "rejected" },
    }),
    awaiting,
  );
  const settled = transitionCommand(awaiting, {
    type: "acknowledged",
    command: { ...command, status: "rejected", error: "Already terminal" },
  });
  assert.equal(commandPending(settled), false);
  assert.equal(commandNotice(settled), "stop: rejected — Already terminal");
  assert.equal(
    transitionCommand(settled, { type: "submit", kind: "reload" }).phase,
    "submitting",
  );
});

test("submission failures preserve the warning and allow a later submission", () => {
  const submitted = transitionCommand(
    { phase: "idle" },
    { type: "submit", kind: "retry" },
  );
  const failed = transitionCommand(submitted, {
    type: "failed",
    message: "Disconnected",
  });
  assert.equal(commandPending(failed), false);
  assert.equal(
    commandNotice(failed),
    "Submission failed: Disconnected. Check status before trying again.",
  );
  assert.equal(
    transitionCommand(failed, { type: "submit", kind: "retry" }).phase,
    "submitting",
  );
});

test("selection retains a filtered run when new runs arrive and scopes project switches", () => {
  const { run } = monitorFixture();
  const newer = { ...run, id: "newer" };
  const other = { ...run, id: "other", projectId: "other-project" };
  const snapshot: MonitorSnapshot = {
    projects: [
      { id: run.projectId, paused: false, blocked: null },
      { id: other.projectId, paused: false, blocked: null },
    ],
    runs: [newer, run, other],
    commands: [],
    visibleRunIds: [newer.id, other.id],
  };
  const selected = selectMonitorRuns(snapshot, {
    projectId: run.projectId,
    runId: run.id,
  });
  assert.equal(selected.run?.id, run.id);
  assert.deepEqual(
    selected.visibleRuns.map((run) => run.id),
    [newer.id, run.id],
  );
  assert.equal(
    selectMonitorRuns(snapshot, { projectId: other.projectId }).run?.id,
    other.id,
  );
  assert.equal(
    selectMonitorRuns(snapshot, { projectId: "missing", runId: "missing" }).run
      ?.id,
    newer.id,
  );
  assert.equal(
    selectMonitorRuns({ ...snapshot, visibleRunIds: [] }, {}).run,
    undefined,
  );
  assert.deepEqual(selectMonitorRuns(undefined, {}), {
    project: undefined,
    projectRuns: [],
    visibleRuns: [],
    run: undefined,
  });
});
