import assert from "node:assert/strict";
import { test } from "node:test";
import { projectRunProjection } from "../src/tui/projection.js";
import { monitorFixture } from "./tui-fixtures.js";

test("action eligibility respects active attempts and pending commands", () => {
  const { run } = monitorFixture();
  const options = { run, projectRuns: [run], pending: false };
  assert.deepEqual(projectRunProjection(options).available, {
    stop: true,
    retry: false,
    recover: false,
  });
  assert.deepEqual(
    projectRunProjection({ ...options, pending: true }).available,
    { stop: false, retry: false, recover: false },
  );
  assert.deepEqual(
    projectRunProjection({ projectRuns: [], pending: false }).available,
    { stop: false, retry: false, recover: false },
  );
  run.outcome = "failed";
  assert.equal(projectRunProjection(options).available.retry, true);
  const active = { ...run, id: "new", attempt: 2, outcome: "running" as const };
  assert.equal(
    projectRunProjection({ ...options, projectRuns: [run, active] }).available
      .retry,
    false,
  );
  assert.equal(
    projectRunProjection({
      ...options,
      projectRuns: [run, { ...active, taskKey: "other" }],
    }).available.retry,
    true,
  );
});

test("recovery explanation preserves domain, project and supersession precedence", () => {
  const { run } = monitorFixture();
  const options = {
    run,
    projectRuns: [run],
    pending: false,
    project: { id: "demo", paused: false, blocked: "Project blocked" },
  };
  assert.match(projectRunProjection(options).recoveryReason!, /Only failed/);
  run.outcome = "failed";
  run.phase = "push";
  Object.assign(run.executions![0]!, {
    fingerprint: "fingerprint",
    failedStep: 3,
  });
  run.base = "base";
  run.head = "head";
  run.snapshot = {
    branch: run.branch,
    head: "head",
    fingerprint: "fingerprint",
    paths: [],
    files: {},
  };
  run.publication = {
    commitMessage: "commit",
    title: "title",
    description: "description",
  };
  assert.equal(projectRunProjection(options).recoveryReason, "Project blocked");
  const unblocked = { ...options, project: undefined };
  assert.equal(projectRunProjection(unblocked).available.recover, true);
  assert.equal(
    projectRunProjection({ ...unblocked, pending: true }).available.recover,
    false,
  );
  assert.equal(
    projectRunProjection({
      ...unblocked,
      projectRuns: [run, { ...run, attempt: 2 }],
    }).recoveryReason,
    "A newer attempt has superseded this run",
  );
});

test("session selection uses execution identity despite shared steps and timestamps", () => {
  const { run, sessions } = monitorFixture();
  run.executions!.push({ ...run.executions![0]!, id: "recovery" });
  const previous = { ...sessions[0]!, id: "previous", executionId: "run" };
  const current = { ...previous, id: "current", executionId: "recovery" };
  const correction = { ...current, id: "correction", attempt: 2 };
  const projected = projectRunProjection({
    run,
    projectRuns: [run],
    pending: false,
    sessions: [previous, current, correction],
  });
  assert.deepEqual(projected.executionSessions, [current, correction]);
});

test("single execution selection excludes records without a matching identity", () => {
  const { run, sessions } = monitorFixture();
  const current = { ...sessions[0]!, executionId: "run" };
  const other = { ...current, id: "other", executionId: "other" };
  const unowned = { ...current, id: "unowned" };
  Reflect.deleteProperty(unowned, "executionId");
  const projected = projectRunProjection({
    run,
    projectRuns: [run],
    pending: false,
    sessions: [unowned, other, current],
  });
  assert.deepEqual(projected.executionSessions, [current]);
  assert.equal(projected.detailLogSession, current);
});

test("queued runs and recovery without new invocations have no current session", () => {
  const { run, sessions } = monitorFixture();
  const options = { run, projectRuns: [run], pending: false, sessions };
  run.executions = undefined;
  assert.deepEqual(projectRunProjection(options).executionSessions, []);
  assert.equal(projectRunProjection(options).detailLogSession, undefined);
  run.executions = [
    {
      id: "recovery",
      fingerprint: "",
      recoverySupported: true,
      createdAt: run.createdAt,
      outcome: "running",
      phase: "push",
    },
  ];
  assert.deepEqual(projectRunProjection(options).executionSessions, []);
});

test("current session selection prefers a running invocation then the latest finished one", () => {
  const { run, sessions } = monitorFixture();
  const running = { ...sessions[0]!, executionId: "run" };
  const finished = {
    ...running,
    id: "finished",
    outcome: "completed",
    startedAt: "2026-09-20T10:02:00Z",
  };
  const options = {
    run,
    projectRuns: [run],
    pending: false,
    sessions: [finished, running],
  };
  assert.equal(projectRunProjection(options).detailLogSession, running);
  running.outcome = "completed";
  assert.equal(projectRunProjection(options).detailLogSession, finished);
});
