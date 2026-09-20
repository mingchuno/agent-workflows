import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { render } from "ink-testing-library";
import stringWidth from "string-width";
import { Monitor } from "../src/tui/index.js";
import { monitorFixture, settle, until } from "./tui-fixtures.js";

const wide = { columns: 120, rows: 30 };
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
    view.stdin.write("\u001b[6~");
    await settle();
    assert.match(view.lastFrame()!, /session-123/);
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

test("selection survives new rows and stale selected-run responses", async () => {
  const { source, run, sessions } = monitorFixture();
  let runs = [
    run,
    { ...run, id: "second", issue: { ...run.issue, title: "Second task" } },
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
      { ...run, id: "new", issue: { ...run.issue, title: "New arrival" } },
      ...runs,
    ];
    await until(() => view.lastFrame()!.includes("New arrival"));
    view.stdin.write("\r");
    await settle();
    assert.match(view.lastFrame()!, /Run: run/);
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
  run.issue.title = "Long issue 界 ".repeat(40);
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
      issue: { ...run.issue, title: "Other project task" },
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
    for (let i = 0; i < 4; i++) {
      view.stdin.write("\u001b[6~");
      await settle();
    }
    const firstAtBottom = view.lastFrame()!.split("\n")[4];
    view.stdin.write("\u001b[A");
    await settle();
    assert.notEqual(view.lastFrame()!.split("\n")[4], firstAtBottom);
  } finally {
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
