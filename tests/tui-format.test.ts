import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cells,
  duration,
  elapsedRun,
  executionDuration,
  wrapLines,
} from "../src/tui/format.js";
import { matchIndex } from "../src/tui/text.js";
import { monitorFixture } from "./tui-fixtures.js";

test("execution duration advances while running and freezes at its own finish", () => {
  const { run } = monitorFixture();
  const execution = run.executions![0]!;
  const now = Date.parse("2026-09-20T10:02:01Z");
  assert.equal(executionDuration(execution, now), "2m 0s");
  execution.finishedAt = "2026-09-20T10:01:01Z";
  execution.outcome = run.outcome = "failed";
  assert.equal(executionDuration(execution, now), "1m 0s");
  assert.equal(elapsedRun(run, now), "1m 1s");
  assert.equal(
    duration(execution.createdAt, execution.startedAt, now),
    "0m 1s",
  );
  assert.equal(duration(undefined, undefined, now), "—");
});

test("terminal formatting measures Unicode cells and strips control sequences", () => {
  assert.equal(cells("界ab", 3), "界a");
  assert.equal(cells("\u001b[31m界ab\u001b[0m", 2), "界");
  assert.deepEqual(wrapLines(["界abcd"], 3), ["界a", "bcd"]);
});

test("literal smart-case matching shares offsets for search and highlighting", () => {
  assert.equal(matchIndex("Hello HELLO", "hello"), 0);
  assert.equal(matchIndex("Hello HELLO", "HELLO"), 6);
  assert.equal(matchIndex("hello", "Hello"), -1);
  assert.equal(matchIndex("prefix [a.*] suffix", "[a.*]"), 7);
  assert.equal(matchIndex("界 Needle", "needle"), 2);
});
