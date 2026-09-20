import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LogFile, presentLogLine } from "../src/tui/log-file.js";

test("log pages follow appends, partial records, truncation and whole-file search", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aw-log-"));
  const path = join(directory, "agent.jsonl");
  const signal = new AbortController().signal;
  try {
    await writeFile(
      path,
      Array.from({ length: 2500 }, (_, i) => `line ${i}`).join("\n") +
        "\npartial",
    );
    const log = new LogFile(path);
    await log.refresh(signal);
    assert.equal(log.count, 2501);
    assert.deepEqual(await log.page(2499, 2, signal), ["line 2499", "partial"]);
    assert.equal(
      await log.search({
        query: "LINE 20",
        from: 0,
        direction: 1,
        raw: true,
        signal,
      }),
      undefined,
    );
    assert.equal(
      await log.search({
        query: "line 20",
        from: 2400,
        direction: 1,
        raw: true,
        signal,
      }),
      20,
    );
    assert.equal(
      await log.search({
        query: "line 20",
        from: 21,
        direction: -1,
        raw: true,
        signal,
      }),
      20,
    );
    await appendFile(path, " finished\nnext\n");
    await log.refresh(signal);
    assert.deepEqual(await log.page(2500, 2, signal), [
      "partial finished",
      "next",
    ]);
    await writeFile(path, "replacement\n");
    await log.refresh(signal);
    assert.equal(log.count, 1);
    assert.deepEqual(await log.page(0, 5, signal), ["replacement"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("readable logs preserve unknown events and neutralize terminal controls", () => {
  assert.match(
    presentLogLine(
      '{"type":"item.completed","item":{"type":"agent_message","text":"Hello"}}',
      false,
    ),
    /agent_message.*Hello/,
  );
  assert.match(presentLogLine('{"type":"unknown","extra":42}', false), /42/);
  assert.equal(presentLogLine("\u001b[31merror\u001b[0m\u0007", true), "error");
});
