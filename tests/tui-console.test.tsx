import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "ink-testing-library";
import { Monitor } from "../packages/cli/src/tui/index.js";
import { monitorFixture, settle, until } from "./tui-fixtures.js";

const size = { columns: 120, rows: 36 };
test("offscreen attention is discoverable and search never submits workflow commands", async () => {
  const { source, run, requests } = monitorFixture();
  const runs = Array.from({ length: 20 }, (_, index) => ({
    ...run,
    id: `run-${index}`,
    taskKey: `task-${index}`,
    subject: {
      ...run.subject,
      number: index + 1,
      title: `Pipeline ${index + 1}`,
    },
    outcome: index === 17 ? ("failed" as const) : ("completed" as const),
  }));
  source.runs = async () => runs;
  source.invocations = async () => [];
  const view = render(<Monitor source={source} size={size} />);
  try {
    await until(() => view.lastFrame()!.includes("Pipeline 1"));
    await settle();
    assert.match(view.lastFrame()!, /1 need attention/);
    view.stdin.write("n");
    await settle();
    view.stdin.write("\r");
    await settle();
    assert.match(view.lastFrame()!, /#18/);
    view.stdin.write("\u001b");
    await settle();
    view.stdin.write("/");
    await settle();
    view.stdin.write("sqrpRFc");
    await settle();
    assert.deepEqual(requests, []);
    assert.doesNotMatch(view.lastFrame()!, /Confirm/);
    view.stdin.write("\u001b");
    await settle();
    view.stdin.write("f");
    await settle();
    assert.match(view.lastFrame()!, /Active/);
    assert.doesNotMatch(view.lastFrame()!, /Pipeline 1\s/);
  } finally {
    view.unmount();
  }
});

test("compact failure overview keeps cause and next action visible and expands exact diagnostics", async () => {
  const { source, run } = monitorFixture();
  run.outcome = run.executions![0]!.outcome = "failed";
  run.error = `Error: ${"provider failure payload ".repeat(80)}tail marker\nUnderlying context`;
  const view = render(
    <Monitor source={source} size={{ columns: 80, rows: 24 }} />,
  );
  try {
    await until(() => view.lastFrame()!.includes("Implement feature"));
    view.stdin.write("\r");
    await settle();
    const frame = view.lastFrame()!;
    assert.match(frame, /Problem/);
    assert.match(frame, /Next/);
    assert.match(frame, /r retry/);
    assert.doesNotMatch(frame, /tail marker/);
    view.stdin.write("d");
    await settle();
    for (let index = 0; index < 5; index++) {
      view.stdin.write("\u001b[6~");
      await settle();
    }
    assert.match(view.lastFrame()!, /tail marker/);
    assert.match(view.lastFrame()!, /Underlying context/);
    assert.match(view.lastFrame()!, /#1.*Implement feature/);
  } finally {
    view.unmount();
  }
});

test("unavailable initial data is distinct from empty and failed refresh retains a stale snapshot", async () => {
  const { source, run } = monitorFixture();
  let offline = true;
  source.runs = async () => {
    if (offline) throw new Error("Database temporarily unavailable");
    return [run];
  };
  const view = render(<Monitor source={source} size={size} />);
  try {
    await until(() => view.lastFrame()!.includes("Connection error"));
    assert.match(view.lastFrame()!, /Snapshot unavailable/);
    assert.doesNotMatch(view.lastFrame()!, /No runs yet/);
    offline = false;
    await until(() => view.lastFrame()!.includes("Database connected"));
    offline = true;
    await until(() => view.lastFrame()!.includes("Stale snapshot"));
    assert.match(view.lastFrame()!, /Implement feature/);
    offline = false;
    await until(() => view.lastFrame()!.includes("Database connected"));
    assert.doesNotMatch(view.lastFrame()!, /Stale snapshot/);
  } finally {
    view.unmount();
  }
});

test("attention selection survives status changes until the user moves", async () => {
  const { source, run } = monitorFixture();
  run.outcome = "failed";
  const second = {
    ...run,
    id: "second",
    taskKey: "second",
    subject: { ...run.subject, number: 2, title: "Second failure" },
  };
  source.runs = async () => [run, second];
  const view = render(<Monitor source={source} size={size} />);
  try {
    await until(() => view.lastFrame()!.includes("Second failure"));
    await settle();
    view.stdin.write("f");
    await settle();
    run.outcome = "completed";
    await until(() => view.lastFrame()!.includes("1 need attention"));
    view.stdin.write("\r");
    await settle();
    assert.match(view.lastFrame()!, /#1 ISSUE Implement feature/);
    assert.match(view.lastFrame()!, /COMPLETED/);
  } finally {
    view.unmount();
  }
});

test("search matches stable references and no-match does not retain an actionable run", async () => {
  const { source, requests } = monitorFixture();
  const view = render(<Monitor source={source} size={size} />);
  try {
    await until(() => view.lastFrame()!.includes("Implement feature"));
    await settle();
    view.stdin.write("/");
    await settle();
    view.stdin.write("#1");
    view.stdin.write("\r");
    await settle();
    assert.match(view.lastFrame()!, /Implement feature/);
    view.stdin.write("/");
    await settle();
    view.stdin.write("\u007f");
    view.stdin.write("\u007f");
    view.stdin.write("unknown");
    view.stdin.write("\r");
    await settle();
    assert.match(view.lastFrame()!, /No matching runs/);
    view.stdin.write("s");
    await settle();
    assert.deepEqual(requests, []);
    assert.doesNotMatch(view.lastFrame()!, /Confirm stop/);
  } finally {
    view.unmount();
  }
});

test("full long subjects remain inspectable and stale data cannot submit a run action", async () => {
  const { source, run, requests } = monitorFixture();
  run.subject.title = "Shared title prefix ".repeat(30) + "distinct ending";
  let offline = false;
  source.runs = async () => {
    if (offline) throw Error("offline");
    return [run];
  };
  const view = render(
    <Monitor source={source} size={{ columns: 80, rows: 24 }} />,
  );
  try {
    await until(() => view.lastFrame()!.includes("Shared title"));
    await settle();
    view.stdin.write("\r");
    await settle();
    view.stdin.write("6");
    await settle();
    assert.match(view.lastFrame()!, /distinct ending/);
    offline = true;
    await until(() => view.lastFrame()!.includes("Stale snapshot"));
    view.stdin.write("s");
    await settle();
    assert.deepEqual(requests, []);
    assert.doesNotMatch(view.lastFrame()!, /Confirm stop/);
    view.stdin.write("x");
    await settle();
    assert.match(view.lastFrame()!, /Snapshot is unavailable or stale/);
  } finally {
    view.unmount();
  }
});

test("failed selected-run evidence does not masquerade as a database outage", async () => {
  const { source } = monitorFixture();
  source.invocations = async () => {
    throw Error("invocation query unavailable");
  };
  const view = render(<Monitor source={source} size={size} />);
  try {
    await until(() =>
      view.lastFrame()!.includes("Selected-run evidence unavailable"),
    );
    assert.match(view.lastFrame()!, /Database connected/);
    assert.doesNotMatch(view.lastFrame()!, /Connection error/);
  } finally {
    view.unmount();
  }
});

test("next attention reaches a failure even from an active-only view", async () => {
  const { source, run } = monitorFixture();
  const failed = {
    ...run,
    id: "failed",
    taskKey: "failed",
    outcome: "failed" as const,
    subject: { ...run.subject, number: 2, title: "Publish failure" },
  };
  source.runs = async () => [run, failed];
  const view = render(<Monitor source={source} size={size} />);
  try {
    await until(() => view.lastFrame()!.includes("Publish failure"));
    await settle();
    view.stdin.write("f");
    await settle();
    view.stdin.write("f");
    await settle();
    assert.match(view.lastFrame()!, /Runs \/ Active/);
    view.stdin.write("n");
    await settle();
    view.stdin.write("\r");
    await settle();
    assert.match(view.lastFrame()!, /#2 ISSUE Publish failure/);
  } finally {
    view.unmount();
  }
});

test("draft readiness is not presented as delivered before successful publication", async () => {
  const { source, run } = monitorFixture();
  run.outcome = "failed";
  run.phase = "push";
  run.readiness = { draft: true, reasons: ["Review limitation"] };
  const view = render(<Monitor source={source} size={size} />);
  try {
    await until(() => view.lastFrame()!.includes("Implement feature"));
    assert.doesNotMatch(view.lastFrame()!, /Draft delivered/);
    assert.match(view.lastFrame()!, /failed.*Push/);
  } finally {
    view.unmount();
  }
});

test("ASCII chrome preserves literal Unicode subjects and check commands", async () => {
  const saved = process.env.AW_TUI_ASCII;
  process.env.AW_TUI_ASCII = "1";
  const { source, run } = monitorFixture();
  run.subject.title = "Fix A→B…";
  run.validation = [
    {
      command: "echo",
      args: ["A→B…"],
      exitCode: 1,
      log: "/tmp/A→B…",
      startedAt: run.createdAt,
      finishedAt: run.updatedAt,
    },
  ];
  const view = render(<Monitor source={source} size={size} />);
  try {
    await until(() => view.lastFrame()!.includes("Fix A→B…"));
    await settle();
    view.stdin.write("\r");
    await settle();
    view.stdin.write("6");
    await settle();
    assert.match(view.lastFrame()!, /Subject\s+Fix A→B…/);
    view.stdin.write("3");
    await settle();
    assert.match(view.lastFrame()!, /echo A→B…/);
  } finally {
    view.unmount();
    if (saved === undefined) delete process.env.AW_TUI_ASCII;
    else process.env.AW_TUI_ASCII = saved;
  }
});

test("full subject expands in overview and state changes acknowledge without moving focus", async () => {
  const { source, run } = monitorFixture();
  run.subject.title = "Shared title prefix ".repeat(30) + "distinct ending";
  const view = render(
    <Monitor source={source} size={{ columns: 80, rows: 24 }} />,
  );
  try {
    await until(() => view.lastFrame()!.includes("Shared title"));
    await settle();
    view.stdin.write("t");
    await settle();
    assert.match(view.lastFrame()!, /distinct ending/);
    assert.match(view.lastFrame()!, /\[Overview\]/);
    run.outcome = "completed";
    await until(() => view.lastFrame()!.includes("State changed"));
    assert.match(view.lastFrame()!, /Run details/);
    assert.match(view.lastFrame()!, /distinct ending/);
  } finally {
    view.unmount();
  }
});

test("selected-run evidence errors do not leak into another run", async () => {
  const { source, run } = monitorFixture();
  const second = {
    ...run,
    id: "second",
    subject: { ...run.subject, title: "Second task" },
  };
  source.runs = async () => [run, second];
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  source.invocations = async (id) => {
    if (id === run.id) throw Error("First evidence error");
    await waiting;
    return [];
  };
  const view = render(<Monitor source={source} size={size} />);
  try {
    await until(() => view.lastFrame()!.includes("First evidence error"));
    view.stdin.write("\u001b[B");
    await settle();
    view.stdin.write("\r");
    await settle();
    assert.match(view.lastFrame()!, /#1 ISSUE Second task/);
    assert.doesNotMatch(view.lastFrame()!, /First evidence error/);
  } finally {
    release();
    view.unmount();
  }
});
