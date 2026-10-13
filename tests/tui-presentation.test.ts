import assert from "node:assert/strict";
import { test } from "node:test";
import { runCounts } from "../packages/cli/src/monitor/discovery.js";
import { failurePresentation } from "../packages/cli/src/tui/presentation.js";
import { projectRunProjection } from "../packages/cli/src/tui/projection.js";
import { consoleFixture } from "./tui-demo-fixtures.js";

test("demo snapshots have distinct executions, fixed terminal times and disjoint counts", async () => {
  const { source, runs, sessions } = consoleFixture(
    Date.parse("2026-10-11T12:00:00Z"),
  );
  const identities = runs.flatMap((run) =>
    run.executions!.map((execution) => execution.id),
  );
  assert.equal(new Set(identities).size, identities.length);
  for (const run of runs) {
    const execution = run.executions![0]!;
    assert.equal(execution.outcome, run.outcome);
    assert.equal(execution.phase, run.phase);
    if (!["queued", "running"].includes(run.outcome))
      assert.equal(execution.finishedAt, "2026-10-11T11:59:50.000Z");
  }
  for (const session of sessions)
    assert.equal(
      (await source.invocations(session.runId))[0]!.executionId,
      session.executionId,
    );
  assert.equal(
    runCounts(runs.filter((run) => run.projectId === "demo")),
    "5 need attention · 2 active · 1 queued · 12 finished",
  );
  await assert.rejects(
    source.request("retry", runs[1]!.id),
    /Read-only demonstration/,
  );
});

test("failure advice uses recorded checks, qualifies provider clues and preserves recovery restrictions", () => {
  const { runs } = consoleFixture();
  const project = (index: number) =>
    projectRunProjection({
      run: runs[index],
      projectRuns: runs,
      pending: false,
    });
  const publication = failurePresentation(runs[1]!, project(1))!;
  assert.match(publication.evidence, /Resource not accessible/);
  assert.match(publication.next, /Possible cause/);
  assert.match(publication.next, /c recover/);
  const validation = failurePresentation(runs[2]!, project(2))!;
  assert.match(validation.problem, /pnpm test --filter permissions exited 1/);
  assert.match(validation.next, /validation logs/);
  assert.doesNotMatch(validation.next, /credential/);
  assert.match(project(5).actionReasons.recover!, /newer attempt/);
  assert.match(project(5).actionReasons.retry!, /active attempt/);
  assert.equal(failurePresentation(runs[4]!, project(4)), undefined);
  const unknown = {
    ...runs[2]!,
    phase: "implementation",
    validation: undefined,
    error: "Opaque provider response",
  };
  const explanation = failurePresentation(
    unknown,
    projectRunProjection({
      run: unknown,
      projectRuns: [unknown],
      pending: false,
    }),
  )!;
  assert.match(explanation.next, /Inspect/);
  assert.doesNotMatch(explanation.next, /credential|403/);
});
