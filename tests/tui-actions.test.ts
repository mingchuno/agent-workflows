import assert from "node:assert/strict";
import { test } from "node:test";
import { actionAvailability } from "../src/tui/actions.js";
import { monitorFixture } from "./tui-fixtures.js";

test("action eligibility respects active attempts and pending commands", () => {
  const { run } = monitorFixture();
  const options = { run, projectRuns: [run], pending: false };
  assert.deepEqual(actionAvailability(options).available, {
    stop: true,
    retry: false,
    recover: false,
  });
  assert.deepEqual(
    actionAvailability({ ...options, pending: true }).available,
    { stop: false, retry: false, recover: false },
  );
  assert.deepEqual(
    actionAvailability({ projectRuns: [], pending: false }).available,
    { stop: false, retry: false, recover: false },
  );
  run.outcome = "failed";
  assert.equal(actionAvailability(options).available.retry, true);
  const active = { ...run, id: "new", attempt: 2, outcome: "running" as const };
  assert.equal(
    actionAvailability({ ...options, projectRuns: [run, active] }).available
      .retry,
    false,
  );
  assert.equal(
    actionAvailability({
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
  assert.match(actionAvailability(options).recoveryReason!, /Only failed/);
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
    diff: "diff",
    paths: [],
    files: {},
  };
  run.publication = {
    commitMessage: "commit",
    title: "title",
    description: "description",
  };
  assert.equal(actionAvailability(options).recoveryReason, "Project blocked");
  const unblocked = { ...options, project: undefined };
  assert.equal(actionAvailability(unblocked).available.recover, true);
  assert.equal(
    actionAvailability({ ...unblocked, pending: true }).available.recover,
    false,
  );
  assert.equal(
    actionAvailability({
      ...unblocked,
      projectRuns: [run, { ...run, attempt: 2 }],
    }).recoveryReason,
    "A newer attempt has superseded this run",
  );
});
