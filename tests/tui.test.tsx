import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { render } from "ink-testing-library";
import stringWidth from "string-width";
import { LogFile } from "../packages/cli/src/monitor/log-file.js";
import { Monitor } from "../packages/cli/src/tui/index.js";
import {
  initialNavigation,
  transitionNavigation,
} from "../packages/cli/src/tui/monitor-navigation.js";
import { monitorFixture, settle, until } from "./tui-fixtures.js";

const wide = { columns: 120, rows: 30 };
const designTarget = { columns: 160, rows: 48 };
test("details open a stage diagnostic when no agent session exists", async () => {
  const { source, run, sessions } = monitorFixture();
  sessions.length = 0;
  run.outcome = "failed";
  run.stageLogs = [
    { executionId: "run", step: "implementation", path: "/missing/stage.log" },
  ];
  const view = render(<Monitor source={source} size={wide} />);
  try {
    await until(() => view.lastFrame()!.includes("Implement feature"));
    view.stdin.write("\r");
    await until(() => view.lastFrame()!.includes("l stage diagnostic"));
    view.stdin.write("l");
    await until(() => view.lastFrame()!.includes("Logs · implementation"));
  } finally {
    view.unmount();
  }
});
test("dashboard has titles, bottom controls, details and confirmed commands", async () => {
  const { source, requests } = monitorFixture();
  let complete = false;
  source.commands = async () =>
    complete
      ? [
          {
            id: "command",
            kind: "stop",
            target: "run",
            status: "success",
            error: null,
          },
        ]
      : [];
  const view = render(<Monitor source={source} size={wide} />);
  try {
    await until(
      () => view.lastFrame()!.includes("Implement feature"),
      view.lastFrame,
    );
    const frame = view.lastFrame()!;
    assert.ok(frame.indexOf("Tab pane") > frame.indexOf("Agent sessions"));
    view.stdin.write("\r");
    await settle();
    view.stdin.write("6");
    await settle();
    assert.match(view.lastFrame()!, /session-123/);
    view.stdin.write("\u001b[6~");
    await settle();
    assert.match(view.lastFrame()!, /requested/);
    view.stdin.write("\u001b");
    await settle();
    view.stdin.write("s");
    await settle();
    assert.match(view.lastFrame()!, /Confirm stop/);
    assert.deepEqual(requests, []);
    view.stdin.write("\u001b");
    await settle();
    assert.deepEqual(requests, []);
    view.stdin.write("s");
    await settle();
    assert.match(view.lastFrame()!, /> Cancel/);
    view.stdin.write("\t");
    await settle();
    assert.match(view.lastFrame()!, /> Confirm/);
    view.stdin.write("\r");
    await until(() => requests.length === 1);
    assert.deepEqual(requests, ["stop:run"]);
    await until(() => view.lastFrame()!.includes("stop: pending"));
    view.stdin.write("p");
    await settle();
    assert.equal(requests.length, 1);
    complete = true;
    await until(() => view.lastFrame()!.includes("stop: success"));
  } finally {
    view.unmount();
  }
});

test("log follows, searches whole file, isolates input and escapes back to selection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aw-tui-"));
  const { source, sessions, requests } = monitorFixture();
  sessions[0]!.log = join(directory, "events.jsonl");
  await writeFile(
    sessions[0]!.log,
    "early sqrp match\n" +
      Array.from({ length: 80 }, (_, i) => `message ${i}`).join("\n") +
      "\n",
  );
  const view = render(<Monitor source={source} size={wide} />);
  try {
    await until(() => view.lastFrame()!.includes("invocation 1"));
    view.stdin.write("l");
    await until(() => view.lastFrame()!.includes("message 79"));
    await appendFile(sessions[0]!.log, "live arrival\n");
    await until(() => view.lastFrame()!.includes("live arrival"));
    view.stdin.write("/");
    await settle();
    view.stdin.write("sqrp");
    await settle();
    view.stdin.write("\r");
    await until(
      () => view.lastFrame()!.includes("early sqrp match"),
      view.lastFrame,
    );
    assert.deepEqual(requests, []);
    view.stdin.write("\u001b");
    await settle();
    assert.match(view.lastFrame()!, /Logs/);
    view.stdin.write("\u001b");
    await settle();
    assert.match(view.lastFrame()!, /Monitor/);
    assert.match(view.lastFrame()!, /Implement feature/);
    assert.doesNotMatch(view.lastFrame()!, /early sqrp match/);
  } finally {
    view.unmount();
    await rm(directory, { recursive: true, force: true });
  }
});

test("horizontal log panning preserves record rows and live follow", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aw-tui-"));
  const { source, sessions } = monitorFixture();
  sessions[0]!.log = join(directory, "events.log");
  const records = Array.from({ length: 26 }, (_, index) => `line-${index + 1}`);
  records[4] = JSON.stringify({
    type: "event",
    metadata: "m".repeat(60),
    text: "short",
  });
  records[5] = `${"a".repeat(60)}active-anchor`;
  records[6] = `${"b".repeat(60)}active-next`;
  await writeFile(sessions[0]!.log, `${records.join("\n")}\n`);
  const view = render(<Monitor source={source} size={wide} />);
  try {
    await until(() => view.lastFrame()!.includes("invocation 1"));
    view.stdin.write("l");
    await until(() =>
      view.lastFrame()!.includes("LIVE FOLLOW · Readable · lines 3–26/26"),
    );
    const initialRows = view.lastFrame()!.split("\n");
    const anchorRow = initialRows.findIndex((row) =>
      row.includes("active-anchor"),
    );
    const nextRow = initialRows.findIndex((row) => row.includes("active-next"));
    assert.ok(anchorRow >= 0);
    assert.ok(initialRows[anchorRow]!.startsWith("a".repeat(60)));
    assert.equal(nextRow, anchorRow + 1);
    assert.ok(initialRows[anchorRow - 1]!.startsWith("event: short"));

    view.stdin.write("\u001b[C");
    view.stdin.write("\u001b[C");
    view.stdin.write("\u001b[C");
    await settle();

    const pannedRows = view.lastFrame()!.split("\n");
    assert.equal(
      pannedRows.findIndex((row) => row.includes("active-anchor")),
      anchorRow,
    );
    assert.equal(
      pannedRows.findIndex((row) => row.includes("active-next")),
      nextRow,
    );
    assert.ok(pannedRows[anchorRow]!.startsWith("active-anchor"));
    assert.equal(pannedRows[anchorRow - 1]!.trim(), "");
    assert.match(view.lastFrame()!, /LIVE FOLLOW · Readable · lines 3–26\/26/);

    view.stdin.write("R");
    await settle();
    assert.match(view.lastFrame()!, /LIVE FOLLOW · Raw · lines 3–26\/26/);
    const rawRows = view.lastFrame()!.split("\n");
    assert.ok(rawRows[anchorRow - 1]!.startsWith("m".repeat(20)));
    assert.ok(rawRows[anchorRow]!.startsWith("active-anchor"));
    assert.equal(
      rawRows.findIndex((row) => row.includes("active-anchor")),
      anchorRow,
    );
    assert.equal(
      rawRows.findIndex((row) => row.includes("active-next")),
      nextRow,
    );

    await appendFile(sessions[0]!.log, `${"z".repeat(60)}live-after-pan\n`);
    await until(() =>
      view.lastFrame()!.includes("LIVE FOLLOW · Raw · lines 4–27/27"),
    );
    assert.match(view.lastFrame()!, /live-after-pan/);
    const rowAfterAppend = view
      .lastFrame()!
      .split("\n")
      .findIndex((row) => row.includes("active-anchor"));

    view.stdin.write("\u001b[D");
    view.stdin.write("\u001b[D");
    view.stdin.write("\u001b[D");
    await settle();
    assert.equal(
      view
        .lastFrame()!
        .split("\n")
        .findIndex((row) => row.includes("active-anchor")),
      rowAfterAppend,
    );
    assert.equal(
      view
        .lastFrame()!
        .split("\n")
        .findIndex((row) => row.includes("active-next")),
      rowAfterAppend + 1,
    );
    assert.ok(
      view.lastFrame()!.split("\n")[rowAfterAppend]!.startsWith("a".repeat(60)),
    );
    assert.match(view.lastFrame()!, /LIVE FOLLOW · Raw · lines 4–27\/27/);
  } finally {
    view.unmount();
    await rm(directory, { recursive: true, force: true });
  }
});

test("completed log panning preserves a manually selected line range", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aw-tui-"));
  const { run, sessions, source } = monitorFixture();
  run.outcome = "completed";
  run.executions![0]!.outcome = "completed";
  sessions[0]!.outcome = "completed";
  sessions[0]!.log = join(directory, "completed.log");
  const records = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`);
  records[3] = "short";
  records[4] = `${"b".repeat(20)}completed-anchor`;
  await writeFile(sessions[0]!.log, `${records.join("\n")}\n`);
  let releasePage!: () => void;
  const pageGate = new Promise<void>((resolve) => {
    releasePage = resolve;
  });
  let pageRequested = false;
  const originalPage = LogFile.prototype.page;
  t.mock.method(
    LogFile.prototype,
    "page",
    async function (
      this: LogFile,
      start: number,
      count: number,
      signal: AbortSignal,
    ) {
      if (this.path === sessions[0]!.log && start === 1) {
        pageRequested = true;
        await pageGate;
      }
      return originalPage.call(this, start, count, signal);
    },
  );
  const view = render(<Monitor source={source} size={wide} />);
  try {
    await until(() => view.lastFrame()!.includes("Implement feature"));
    view.stdin.write("\r");
    await until(() => view.lastFrame()!.includes("l log: implementation"));
    view.stdin.write("l");
    await until(() =>
      view.lastFrame()!.includes("LIVE FOLLOW · Readable · lines 7–30/30"),
    );
    for (let index = 0; index < 5; index++) view.stdin.write("\u001b[A");
    await until(() => pageRequested);
    assert.match(view.lastFrame()!, /lines 7–30\/30/);
    assert.doesNotMatch(view.lastFrame()!, /completed-anchor/);
    releasePage();
    await until(() =>
      view.lastFrame()!.includes("SCROLLING · Readable · lines 2–25/30"),
    );
    const anchorRow = view
      .lastFrame()!
      .split("\n")
      .findIndex((row) => row.includes("completed-anchor"));
    assert.ok(anchorRow >= 0);

    view.stdin.write("\u001b[C");
    await settle();

    assert.equal(
      view
        .lastFrame()!
        .split("\n")
        .findIndex((row) => row.includes("completed-anchor")),
      anchorRow,
    );
    assert.ok(
      view.lastFrame()!.split("\n")[anchorRow]!.startsWith("completed-anchor"),
    );
    assert.match(view.lastFrame()!, /SCROLLING · Readable · lines 2–25\/30/);
  } finally {
    releasePage();
    view.unmount();
    await rm(directory, { recursive: true, force: true });
  }
});

test("default selection synchronization retains confirmation for the displayed run", () => {
  const state = {
    ...initialNavigation,
    modal: {
      type: "confirmation" as const,
      kind: "retry-refresh" as const,
      runId: "run",
      title: "Implement feature",
    },
  };
  const selected = transitionNavigation(state, {
    type: "selection",
    selection: { projectId: "demo", runId: "run" },
  }).state;
  assert.deepEqual(selected.modal, state.modal);
  const changed = transitionNavigation(selected, {
    type: "selection",
    selection: { projectId: "demo", runId: "another-run" },
  }).state;
  assert.equal(changed.modal, undefined);
});

test("selection survives new rows and stale selected-run responses", async () => {
  const { source, run, sessions } = monitorFixture();
  let runs = [
    run,
    { ...run, id: "second", subject: { ...run.subject, title: "Second task" } },
  ];
  source.runs = async () => runs;
  let release!: (value: typeof sessions) => void;
  let blocked = false;
  let began = false;
  source.invocations = async (id) => {
    if (id === "run" && blocked) {
      began = true;
      return new Promise((resolve) => {
        release = resolve;
      });
    }
    return sessions.map((session) => ({
      ...session,
      runId: id,
      id,
      step: `${id}-session`,
    }));
  };
  const view = render(<Monitor source={source} size={wide} />);
  try {
    await until(() => view.lastFrame()!.includes("run-session"));
    runs = [
      { ...run, id: "new", subject: { ...run.subject, title: "New arrival" } },
      ...runs,
    ];
    await until(() => view.lastFrame()!.includes("New arrival"));
    view.stdin.write("\r");
    await settle();
    assert.match(view.lastFrame()!, /run-session/);
    view.stdin.write("\u001b");
    await settle();
    blocked = true;
    await until(() => began);
    view.stdin.write("\u001b[B");
    await until(() => view.lastFrame()!.includes("second-session"));
    release(sessions);
    await settle();
    assert.match(view.lastFrame()!, /second-session/);
    assert.doesNotMatch(view.lastFrame()!, /run-session/);
  } finally {
    release?.(sessions);
    view.unmount();
  }
});

test("event cursor progresses beyond 1000 records and connection recovers", async () => {
  const { source } = monitorFixture();
  const cursors: number[] = [];
  let fail = false;
  source.projects = async () => {
    if (fail) throw new Error("offline");
    return [{ id: "demo", paused: false, blocked: null }];
  };
  source.events = async (after = 0) => {
    cursors.push(after);
    return Array.from(
      { length: after === 0 ? 1000 : after === 1000 ? 1 : 0 },
      (_, i) => ({
        sequence: after + i + 1,
        runId: "run",
        kind: "step",
        payload: { name: after === 1000 ? "latest-after-cap" : `step-${i}` },
        createdAt: "",
      }),
    );
  };
  const view = render(<Monitor source={source} size={wide} />);
  try {
    await until(() => view.lastFrame()!.includes("latest-after-cap"));
    assert.ok(cursors.includes(1000));
    fail = true;
    await until(() => view.lastFrame()!.includes("Connection error"));
    fail = false;
    await until(() => view.lastFrame()!.includes("Database connected"));
    assert.doesNotMatch(view.lastFrame()!, /Connection error/);
  } finally {
    view.unmount();
  }
});

test("compact, wide and resized screens stay within terminal bounds", async () => {
  const { source, run } = monitorFixture();
  run.subject.title = "Long issue 界 ".repeat(40);
  run.error = "Long error ".repeat(100);
  const view = render(<Monitor source={source} size={wide} />);
  try {
    await until(() => view.lastFrame()!.includes("Long issue"));
    for (const size of [
      wide,
      { columns: 80, rows: 24 },
      { columns: 150, rows: 40 },
    ]) {
      view.rerender(<Monitor source={source} size={size} />);
      await settle();
      for (const key of ["", "\r", "\u001b", "?"]) {
        if (key) {
          view.stdin.write(key);
          await settle();
        }
        const lines = view.lastFrame()!.split("\n");
        assert.ok(lines.length <= size.rows, `${lines.length} > ${size.rows}`);
        assert.ok(lines.every((line) => stringWidth(line) <= size.columns));
      }
      view.stdin.write("\u001b");
      await settle();
    }
    view.rerender(<Monitor source={source} size={{ columns: 60, rows: 15 }} />);
    await settle();
    assert.match(view.lastFrame()!, /Resize terminal/);
  } finally {
    view.unmount();
  }
});

test("F preserves refreshed-issue retry after R becomes reload", async () => {
  const { source, run, requests } = monitorFixture();
  run.outcome = "failed";
  const view = render(<Monitor source={source} size={wide} />);
  try {
    await until(() => view.lastFrame()!.includes("r retry"));
    view.stdin.write("F");
    await until(() => view.lastFrame()!.includes("Confirm retry-refresh"));
    view.stdin.write("\t");
    await until(() => view.lastFrame()!.includes("> Confirm"));
    view.stdin.write("\r");
    await until(() => requests.length === 1);
    assert.deepEqual(requests, ["retry-refresh:run"]);
  } finally {
    view.unmount();
  }
});

test("reload shortcut works without a selected run and displays server acknowledgement", async () => {
  const { source, requests } = monitorFixture();
  source.runs = async () => [];
  let status = "pending";
  let error: string | null = null;
  source.commands = async () => [
    { id: "command", kind: "reload", target: "", status, error },
  ];
  const view = render(<Monitor source={source} size={wide} />);
  try {
    await until(() => view.lastFrame()!.includes("Database connected"));
    view.stdin.write("R");
    await until(() => requests.length === 1);
    assert.deepEqual(requests, ["reload:"]);
    await until(() => view.lastFrame()!.includes("reload: pending"));
    view.stdin.write("R");
    await settle();
    assert.equal(requests.length, 1);
    status = "success";
    await until(() => view.lastFrame()!.includes("reload: success"));
    status = "pending";
    view.stdin.write("R");
    await until(() => requests.length === 2);
    status = "failed";
    error = "Configuration changes require restart: id";
    await until(() => view.lastFrame()!.includes("reload: failed"));
    assert.match(view.lastFrame()!, /require restart: id/);
  } finally {
    view.unmount();
  }
});

test("pending command survives project navigation and blocks duplicate submission", async () => {
  const { source, run, requests } = monitorFixture();
  source.projects = async () =>
    ["demo", "other"].map((id) => ({ id, paused: false, blocked: null }));
  source.runs = async () => [
    run,
    {
      ...run,
      id: "other-run",
      projectId: "other",
      subject: { ...run.subject, title: "Other project task" },
    },
  ];
  let release!: (id: string) => void;
  source.request = async (kind, target) => {
    requests.push(`${kind}:${target}`);
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  source.commands = async () => [
    {
      id: "command",
      kind: "pause",
      target: "demo",
      status: "success",
      error: null,
    },
  ];
  const view = render(<Monitor source={source} size={wide} />);
  try {
    await until(() => view.lastFrame()!.includes("Implement feature"));
    view.stdin.write("p");
    await until(() => requests.length === 1);
    view.stdin.write("\u001b[C");
    await until(() => view.lastFrame()!.includes("Other project task"));
    view.stdin.write("p");
    await settle();
    assert.deepEqual(requests, ["pause:demo"]);
    assert.match(view.lastFrame()!, /pause: pending/);
    release("command");
    await until(() => view.lastFrame()!.includes("pause: success"));
  } finally {
    release?.("command");
    view.unmount();
  }
});

test("scrolling details clamps at the bottom so Up moves immediately", async () => {
  const { source, run } = monitorFixture();
  run.outcome = run.executions![0]!.outcome = "completed";
  run.executions![0]!.finishedAt = "2026-09-20T10:02:01Z";
  const view = render(
    <Monitor source={source} size={{ columns: 80, rows: 24 }} />,
  );
  try {
    await until(() => view.lastFrame()!.includes("Implement feature"));
    view.stdin.write("\r");
    await settle();
    view.stdin.write("6");
    await settle();
    for (let i = 0; i < 4; i++) {
      view.stdin.write("\u001b[6~");
      await settle();
    }
    const firstAtBottom = view.lastFrame()!.match(/lines (\d+)[–-]/)?.[1];
    view.stdin.write("\u001b[A");
    await settle();
    assert.notEqual(
      view.lastFrame()!.match(/lines (\d+)[–-]/)?.[1],
      firstAtBottom,
    );
  } finally {
    view.unmount();
  }
});

test("overview leads with identity and separates checks from activity evidence", async () => {
  const { source, run, sessions } = monitorFixture();
  run.validation = [
    {
      command: "pnpm",
      args: ["test"],
      exitCode: 0,
      log: "/tmp/check.log",
      startedAt: run.createdAt,
      finishedAt: run.updatedAt,
    },
  ];
  sessions[0]!.requested = {
    provider: "codex",
    model: "requested",
    reasoningEffort: "medium",
  };
  sessions[0]!.effective = {
    provider: "codex",
    model: "effective",
    reasoningEffort: "high",
  };
  const view = render(<Monitor source={source} size={designTarget} />);
  try {
    await until(() => view.lastFrame()!.includes("l log"));
    view.stdin.write("\r");
    await settle();
    assert.match(view.lastFrame()!, /demo \/ #1 ISSUE Implement feature/);
    assert.match(view.lastFrame()!, /RUNNING.*Implementation/);
    assert.match(view.lastFrame()!, /Branch.*agent\/1/);
    assert.doesNotMatch(view.lastFrame()!, /Requested codex/);
    view.stdin.write("3");
    await settle();
    assert.match(view.lastFrame()!, /pnpm test.*exit 0/);
    view.stdin.write("2");
    await settle();
    assert.match(view.lastFrame()!, /Requested codex \/ requested \/ medium/);
    assert.match(view.lastFrame()!, /Effective codex \/ effective \/ high/);
  } finally {
    view.unmount();
  }
});

test("compact lists and split workspaces retain identity across resize", async () => {
  const { source } = monitorFixture();
  const view = render(
    <Monitor source={source} size={{ columns: 111, rows: 30 }} />,
  );
  try {
    await until(() => view.lastFrame()!.includes("Implement feature"));
    assert.doesNotMatch(view.lastFrame()!, /Overview [·|] Enter inspect/);
    view.rerender(
      <Monitor source={source} size={{ columns: 112, rows: 30 }} />,
    );
    await settle();
    assert.match(view.lastFrame()!, /Overview [·|] Enter inspect/);
    view.stdin.write("\r");
    await settle();
    view.rerender(<Monitor source={source} size={{ columns: 80, rows: 24 }} />);
    await settle();
    assert.match(view.lastFrame()!, /demo \/ #1 ISSUE Implement feature/);
    assert.match(view.lastFrame()!, /RUNNING/);
  } finally {
    view.unmount();
  }
});

test("details reserve attention for outcomes that require it", async () => {
  for (const [outcome, expectsAttention] of [
    ["queued", false],
    ["completed", false],
    ["no-change", false],
    ["blocked", true],
    ["cancelled", true],
  ] as const) {
    const { source, run } = monitorFixture();
    run.outcome = run.executions![0]!.outcome = outcome;
    if (!["queued", "running"].includes(outcome))
      run.executions![0]!.finishedAt = "2026-09-20T10:02:01Z";
    const view = render(<Monitor source={source} size={designTarget} />);
    try {
      await until(() => view.lastFrame()!.includes("Implement feature"));
      view.stdin.write("\r");
      await settle();
      assert.equal(view.lastFrame()!.includes("Problem"), expectsAttention);
    } finally {
      view.unmount();
    }
  }
});

test("matching requested and effective profiles render once as effective", async () => {
  const { source, sessions } = monitorFixture();
  const profile = {
    provider: "codex",
    model: "same-model",
    reasoningEffort: "medium",
  };
  sessions[0]!.requested = profile;
  sessions[0]!.effective = { ...profile };
  const view = render(<Monitor source={source} size={designTarget} />);
  try {
    await until(() => view.lastFrame()!.includes("Implement feature"));
    view.stdin.write("\r");
    await settle();
    view.stdin.write("2");
    await settle();
    assert.match(view.lastFrame()!, /Effective codex \/ same-model \/ medium/);
    assert.doesNotMatch(
      view.lastFrame()!,
      /Requested codex \/ same-model \/ medium/,
    );
  } finally {
    view.unmount();
  }
});

test("overview explains action restrictions and exact diagnostics remain accessible", async () => {
  const { source, run } = monitorFixture();
  run.outcome = run.executions![0]!.outcome = "failed";
  run.error = "Error: concise failure\ncomplete diagnostic evidence";
  run.subject.url = "https://example.test/issues/1?exact=yes";
  const view = render(<Monitor source={source} size={designTarget} />);
  try {
    await until(() => view.lastFrame()!.includes("Implement feature"));
    view.stdin.write("\r");
    await settle();
    assert.match(view.lastFrame()!, /Evidence.*concise failure/);
    assert.match(
      view.lastFrame()!,
      /Recovery.*Recovery does not support implementation/,
    );
    assert.match(view.lastFrame()!, /Action.*r retry/);
    view.stdin.write("d");
    await settle();
    assert.match(view.lastFrame()!, /complete diagnostic evidence/);
    view.stdin.write("6");
    await settle();
    assert.match(
      view.lastFrame()!,
      /https:\/\/example\.test\/issues\/1\?exact=yes/,
    );
    assert.match(view.lastFrame()!, /Run ID.*run/);
  } finally {
    view.unmount();
  }
});

test("overview bounds provider payloads while diagnostics preserve the tail", async () => {
  const { source, run } = monitorFixture();
  run.outcome = "failed";
  run.error = `Error: ${"provider failure payload ".repeat(80)}tail marker`;
  const view = render(<Monitor source={source} size={designTarget} />);
  try {
    await until(() => view.lastFrame()!.includes("Implement feature"));
    view.stdin.write("\r");
    await settle();
    assert.match(view.lastFrame()!, /Evidence.*provider failure payload/);
    assert.match(view.lastFrame()!, /…|\.\.\./);
    assert.doesNotMatch(view.lastFrame()!, /tail marker/);
    view.stdin.write("d");
    await settle();
    view.stdin.write("\u001b[F");
    await settle();
    assert.match(view.lastFrame()!, /tail marker/);
  } finally {
    view.unmount();
  }
});

test("health summary distinguishes successful and failed validation", async () => {
  const { source, run } = monitorFixture();
  run.validation = [
    {
      command: "pnpm",
      args: ["check"],
      exitCode: 0,
      log: "/tmp/check.log",
      startedAt: "2026-09-20T10:00:10Z",
      finishedAt: "2026-09-20T10:00:20Z",
    },
    {
      command: "pnpm",
      args: ["test"],
      exitCode: 1,
      log: "/tmp/test.log",
      startedAt: "2026-09-20T10:00:20Z",
      finishedAt: "2026-09-20T10:00:30Z",
    },
  ];
  const view = render(<Monitor source={source} size={designTarget} />);
  try {
    await until(() => view.lastFrame()!.includes("Implement feature"));
    view.stdin.write("\r");
    await settle();
    view.stdin.write("3");
    await settle();
    assert.match(view.lastFrame()!, /pnpm check.*exit 0/);
    assert.match(view.lastFrame()!, /pnpm test.*exit 1/);
  } finally {
    view.unmount();
  }
});

test("details show latest execution first and l selects the current running session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aw-tui-current-"));
  const { source, run, sessions } = monitorFixture();
  run.executions = [
    {
      ...run.executions![0]!,
      id: "original-execution",
      outcome: "failed",
      phase: "push",
      finishedAt: "2026-09-20T10:01:00Z",
      failedStep: 8,
    },
    {
      id: "recovery-execution",
      recoveryOf: "original-execution",
      startStep: 8,
      reusedSteps: ["implementation", "validation", "commit"],
      fingerprint: "fingerprint",
      recoverySupported: true,
      createdAt: "2026-09-20T10:02:00Z",
      startedAt: "2026-09-20T10:02:01Z",
      outcome: "running",
      phase: "push",
    },
  ];
  sessions.splice(
    0,
    1,
    {
      ...sessions[0]!,
      id: "old",
      executionId: "original-execution",
      sessionId: "old-session",
      startedAt: "2026-09-20T10:00:01Z",
      log: join(directory, "old.log"),
    },
    {
      ...sessions[0]!,
      id: "finished-current",
      executionId: "recovery-execution",
      sessionId: "finished-session",
      startedAt: "2026-09-20T10:02:02Z",
      finishedAt: "2026-09-20T10:02:03Z",
      outcome: "completed",
      log: join(directory, "finished.log"),
    },
    {
      ...sessions[0]!,
      id: "running-current",
      executionId: "recovery-execution",
      sessionId: "running-session",
      startedAt: "2026-09-20T10:02:04Z",
      outcome: "running",
      log: join(directory, "running.log"),
    },
  );
  await Promise.all([
    writeFile(join(directory, "old.log"), "OLD LOG\n"),
    writeFile(join(directory, "finished.log"), "FINISHED LOG\n"),
    writeFile(join(directory, "running.log"), "RUNNING CURRENT LOG\n"),
  ]);
  const view = render(<Monitor source={source} size={designTarget} />);
  try {
    await until(() => view.lastFrame()!.includes("Implement feature"));
    view.stdin.write("\r");
    await settle();
    view.stdin.write("4");
    await settle();
    const frame = view.lastFrame()!;
    assert.ok(
      frame.indexOf("Current execution") < frame.indexOf("Prior execution 1"),
    );
    assert.match(
      frame,
      /failed [·|] push [·|] duration 0m 59s [·|] queue 0m 1s/,
    );
    assert.match(frame, /l log: implementation invocation 1 \(running\)/);
    view.stdin.write("l");
    await until(() => view.lastFrame()!.includes("RUNNING CURRENT LOG"));
    assert.doesNotMatch(view.lastFrame()!, /OLD LOG/);
  } finally {
    view.unmount();
    await rm(directory, { recursive: true, force: true });
  }
});

test("details expose overflow range and ignore dashboard-only navigation keys", async () => {
  const { source, run, requests } = monitorFixture();
  run.error = "large error ".repeat(100);
  const view = render(
    <Monitor source={source} size={{ columns: 80, rows: 24 }} />,
  );
  try {
    await until(() => view.lastFrame()!.includes("Implement feature"));
    view.stdin.write("\r");
    await settle();
    assert.match(view.lastFrame()!, /lines 1[–-]\d+ of \d+/);
    for (const input of ["a", "[", "]", "p"]) {
      view.stdin.write(input);
      await settle();
    }
    assert.deepEqual(requests, []);
    assert.match(view.lastFrame()!, /Run details/);
    assert.match(view.lastFrame()!, /runner liveness unverified/);
    assert.match(view.lastFrame()!, /q close/);
    view.stdin.write("\u001b[6~");
    await settle();
    assert.match(view.lastFrame()!, /lines \d+[–-]\d+ of \d+/);
  } finally {
    view.unmount();
  }
});

test("80-column details keep primary controls visible and secondary actions discoverable", async () => {
  const { source, run, sessions } = monitorFixture();
  let releaseSessions!: () => void;
  const sessionLoad = new Promise<void>((resolve) => {
    releaseSessions = resolve;
  });
  source.invocations = async () => {
    await sessionLoad;
    return sessions;
  };
  run.outcome = run.executions![0]!.outcome = "failed";
  run.phase = run.executions![0]!.phase = "push";
  run.executions![0]!.finishedAt = "2026-09-20T10:02:01Z";
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
  run.validation = [
    {
      command: "pnpm",
      args: ["test"],
      exitCode: 0,
      log: "/tmp/test.log",
      startedAt: "2026-09-20T10:00:10Z",
      finishedAt: "2026-09-20T10:00:20Z",
    },
  ];
  const view = render(
    <Monitor source={source} size={{ columns: 80, rows: 24 }} />,
  );
  try {
    await until(() => view.lastFrame()!.includes("Implement feature"));
    assert.ok(!view.lastFrame()!.includes("l log"));
    releaseSessions();
    await until(() => view.lastFrame()!.includes("l log"), view.lastFrame);
    const dashboardFooter = view
      .lastFrame()!
      .split("\n")
      .filter((line) => line.trim())
      .at(-1)!;
    for (const control of [
      "l log",
      "v checks",
      "c recover",
      "R reload",
      "? help",
      "q close",
    ])
      assert.ok(
        dashboardFooter.includes(control),
        `Missing dashboard control ${control}: ${dashboardFooter}`,
      );
    view.stdin.write("\r");
    await settle();
    const footer = view.lastFrame()!.split("\n").at(-1)!;
    for (const control of [
      "l log",
      "v checks",
      "c recover",
      "R reload",
      "? help",
      "q close",
    ]) {
      assert.match(footer, new RegExp(control.replace("?", "\\?")));
    }
    assert.ok(stringWidth(footer) <= 80);
    view.stdin.write("x");
    await settle();
    assert.match(view.lastFrame()!, /r retry: Available/);
    assert.match(view.lastFrame()!, /Continue the failed publication step/);
  } finally {
    view.unmount();
  }
});

test("details scroll from the clamped position after a live resize", async () => {
  const { source, run } = monitorFixture();
  run.error = Array.from(
    { length: 100 },
    (_, index) => `diagnostic line ${index}`,
  ).join("\n");
  const view = render(
    <Monitor source={source} size={{ columns: 80, rows: 24 }} />,
  );
  try {
    await until(() => view.lastFrame()!.includes("Implement feature"));
    view.stdin.write("\r");
    await settle();
    view.stdin.write("d");
    await settle();
    for (let index = 0; index < 10; index++) {
      view.stdin.write("\u001b[6~");
      await settle();
    }
    view.rerender(<Monitor source={source} size={designTarget} />);
    await settle();
    const before = view.lastFrame()!.match(/lines (\d+)[–-]/)?.[1];
    assert.ok(before);
    view.stdin.write("\u001b[A");
    await settle();
    const after = view.lastFrame()!.match(/lines (\d+)[–-]/)?.[1];
    assert.equal(Number(after), Number(before) - 1);
  } finally {
    view.unmount();
  }
});

test("NO_COLOR details retain textual hierarchy and status", async () => {
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  const { source } = monitorFixture();
  const view = render(<Monitor source={source} size={designTarget} />);
  try {
    await until(() => view.lastFrame()!.includes("Implement feature"));
    view.stdin.write("\r");
    await settle();
    assert.match(view.lastFrame()!, /RUNNING.*Implementation/);
    view.stdin.write("4");
    await settle();
    assert.match(view.lastFrame()!, /Current execution/);
    view.stdin.write("3");
    await settle();
    assert.match(view.lastFrame()!, /Workflow validation/);
    view.stdin.write("2");
    await settle();
    assert.match(view.lastFrame()!, /Agent sessions/);
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
    view.unmount();
  }
});

test("help dialog groups shortcuts, captures input and restores details", async () => {
  const { source, requests } = monitorFixture();
  const view = render(
    <Monitor source={source} size={{ columns: 80, rows: 24 }} />,
  );
  try {
    await until(() => view.lastFrame()!.includes("Implement feature"));
    view.stdin.write("\r");
    await settle();
    view.stdin.write("?");
    await settle();
    assert.match(view.lastFrame()!, /Keyboard shortcuts/);
    assert.match(view.lastFrame()!, /Next pane/);
    assert.doesNotMatch(view.lastFrame()!, /Next pane.*Previous pane/);
    view.stdin.write("\t");
    await settle();
    assert.match(view.lastFrame()!, /Stop selected run/);
    view.stdin.write("s");
    await settle();
    assert.deepEqual(requests, []);
    assert.match(view.lastFrame()!, /Keyboard shortcuts/);
    view.stdin.write("\u001b");
    await settle();
    assert.match(view.lastFrame()!, /Run details/);
  } finally {
    view.unmount();
  }
});

test("confirmation defaults to Cancel and traps focus while Tab changes options", async () => {
  const { source, requests } = monitorFixture();
  const view = render(
    <Monitor source={source} size={{ columns: 80, rows: 24 }} />,
  );
  try {
    await until(() => view.lastFrame()!.includes("Implement feature"));
    await settle();
    view.stdin.write("s");
    await settle();
    assert.match(view.lastFrame()!, /> Cancel/);
    view.stdin.write("\r");
    await settle();
    assert.deepEqual(requests, []);
    assert.doesNotMatch(view.lastFrame()!, /Confirm stop/);
    view.stdin.write("s");
    await settle();
    view.stdin.write("\u001b[Z");
    await settle();
    assert.match(view.lastFrame()!, /> Confirm/);
    view.stdin.write("p");
    await settle();
    assert.deepEqual(requests, []);
    view.stdin.write("\t");
    await settle();
    assert.match(view.lastFrame()!, /> Cancel/);
    view.stdin.write("\u001b");
    await settle();
    assert.deepEqual(requests, []);
  } finally {
    view.unmount();
  }
});

test("help and confirmation restore the scrolled details after a terminal resize", async () => {
  const { source, run, requests } = monitorFixture();
  run.error = "diagnostic line\n".repeat(100);
  const size = { columns: 80, rows: 24 };
  const view = render(<Monitor source={source} size={size} />);
  try {
    await until(() => view.lastFrame()!.includes("Implement feature"));
    view.stdin.write("\r");
    await settle();
    view.stdin.write("d");
    await settle();
    view.stdin.write("\u001b[6~");
    await settle();
    const line = view.lastFrame()!.match(/lines (\d+)[–-]/)?.[1];
    assert.ok(Number(line) > 1);
    for (const shortcut of ["?", "s"]) {
      view.stdin.write(shortcut);
      await settle();
      view.rerender(
        <Monitor source={source} size={{ columns: 40, rows: 10 }} />,
      );
      await settle();
      assert.match(view.lastFrame()!, /Resize terminal/);
      view.stdin.write("p");
      await settle();
      view.rerender(<Monitor source={source} size={size} />);
      await settle();
      assert.match(
        view.lastFrame()!,
        shortcut === "?" ? /Keyboard shortcuts/ : /Confirm stop/,
      );
      view.stdin.write("\u001b");
      await settle();
      assert.match(view.lastFrame()!, /Run details/);
      assert.equal(view.lastFrame()!.match(/lines (\d+)[–-]/)?.[1], line);
    }
    assert.deepEqual(requests, []);
  } finally {
    view.unmount();
  }
});

test("a removed selected run dismisses its confirmation without submitting a command", async () => {
  const { source, run, requests } = monitorFixture();
  let runs = [run];
  source.runs = async () => runs;
  const view = render(<Monitor source={source} size={wide} />);
  try {
    await until(() => view.lastFrame()!.includes("Implement feature"));
    await settle();
    view.stdin.write("s");
    await until(
      () => view.lastFrame()!.includes("Confirm stop"),
      view.lastFrame,
    );
    runs = [
      {
        ...run,
        id: "replacement",
        subject: { ...run.subject, title: "Replacement task" },
      },
    ];
    await until(() => view.lastFrame()!.includes("Replacement task"));
    assert.doesNotMatch(view.lastFrame()!, /Confirm stop/);
    assert.deepEqual(requests, []);
  } finally {
    view.unmount();
  }
});

test("batched detail scroll keys each advance the viewport", async () => {
  const { source, run } = monitorFixture();
  run.error = "diagnostic line\n".repeat(100);
  const view = render(
    <Monitor source={source} size={{ columns: 80, rows: 24 }} />,
  );
  try {
    await until(() => view.lastFrame()!.includes("Implement feature"));
    view.stdin.write("\r");
    await settle();
    view.stdin.write("d");
    await settle();
    const before = Number(view.lastFrame()!.match(/lines (\d+)[–-]/)?.[1]);
    view.stdin.write("\u001b[B");
    view.stdin.write("\u001b[B");
    view.stdin.write("\u001b[B");
    await settle();
    assert.equal(
      Number(view.lastFrame()!.match(/lines (\d+)[–-]/)?.[1]),
      before + 3,
    );
  } finally {
    view.unmount();
  }
});

test("project navigation at its boundary preserves the displayed run's session selection", async () => {
  const { source, sessions } = monitorFixture();
  sessions.push({
    ...sessions[0]!,
    id: "second-invocation",
    step: "review",
    attempt: 2,
  });
  const view = render(<Monitor source={source} size={wide} />);
  try {
    await until(
      () =>
        view.lastFrame()!.includes("review · invocation 2") ||
        view.lastFrame()!.includes("review | invocation 2"),
    );
    view.stdin.write("a");
    await settle();
    view.stdin.write("\u001b[B");
    await settle();
    assert.match(view.lastFrame()!, /> review [·|] invocation 2/);
    view.stdin.write("\u001b[D");
    await settle();
    assert.match(view.lastFrame()!, /> review [·|] invocation 2/);
    view.stdin.write("l");
    await settle();
    assert.match(view.lastFrame()!, /Logs · review · invocation 2/);
  } finally {
    view.unmount();
  }
});

test("completed draft details expose unresolved review and agent-reported evidence", async () => {
  const { source, run } = monitorFixture();
  run.outcome = "completed";
  run.readiness = { draft: true, reasons: ["Blocking review findings remain"] };
  run.review = {
    complete: false,
    summary: "Partial review",
    limitations: ["Dependency not inspected"],
    findings: [
      {
        priority: "P1",
        body: "Missing authorization",
        path: "api.ts",
        line: 12,
      },
    ],
  };
  run.agentReport = {
    summary: "Implemented",
    validation: [
      {
        command: "task-specific check",
        outcome: "failed",
        details: "Permission test failed",
      },
    ],
    limitations: ["Integration service unavailable"],
  };
  const view = render(
    <Monitor source={source} size={{ columns: 160, rows: 80 }} />,
  );
  try {
    await until(() => view.lastFrame()!.includes("Implement feature"));
    view.stdin.write("\r");
    await until(() => view.lastFrame()!.includes("Run details"));
    view.stdin.write("3");
    await settle();
    assert.match(view.lastFrame()!, /Missing authorization/);
    assert.match(view.lastFrame()!, /Dependency not inspected/);
    assert.match(view.lastFrame()!, /task-specific check.*failed/);
    assert.match(view.lastFrame()!, /Integration service unavailable/);
  } finally {
    view.unmount();
  }
});

test("configuration view scrolls accepted JSON, refreshes it and labels a failed read stale", async () => {
  const { source } = monitorFixture();
  const { configSchema } = await import("../packages/core/src/config.js");
  let current = configSchema.parse({
    id: "local",
    projects: [
      {
        id: "demo",
        checkout: "../demo",
        hosting: {
          provider: "github",
          origin: "https://github.com",
          repository: "owner/demo",
          tokenEnv: "TOKEN",
        },
        agent: { provider: "codex" },
      },
    ],
  });
  let failed = false;
  source.configuration = async () => {
    if (failed) throw new Error("Runner unavailable");
    return current;
  };
  const view = render(<Monitor source={source} size={wide} />);
  try {
    await until(() => view.lastFrame()!.includes("Implement feature"));
    view.stdin.write("C");
    await until(() => view.lastFrame()!.includes('"id": "local"'));
    assert.match(view.lastFrame()!, /Active configuration/);
    view.stdin.write("\u001b[6~");
    await settle();
    assert.match(view.lastFrame()!, /pollIntervalMs/);
    current = { ...current, id: "accepted-reload" };
    view.stdin.write("\u001b[H");
    await until(() => view.lastFrame()!.includes("accepted-reload"));
    failed = true;
    await until(() => view.lastFrame()!.includes("Stale configuration"));
    assert.match(view.lastFrame()!, /accepted-reload/);
    view.stdin.write("\u001b");
    await until(() => view.lastFrame()!.includes("Implement feature"));
  } finally {
    view.unmount();
  }
});
