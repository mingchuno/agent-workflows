/** Live read-only scenarios: node --import tsx tests/tui-demo.tsx [mixed|empty|offline|stale|pending|long-error] */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { Monitor } from "../packages/cli/src/tui/index.js";
import { consoleFixture } from "./tui-demo-fixtures.js";

const { source, runs, sessions } = consoleFixture();
const directory = await mkdtemp(join(tmpdir(), "aw-monitor-demo-"));
const scenario = process.argv[2] ?? "mixed";
const timers: ReturnType<typeof setTimeout>[] = [];
for (const session of sessions) {
  session.log = join(directory, `${session.id}.jsonl`);
  await writeFile(
    session.log,
    Array.from({ length: 80 }, (_, index) =>
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: `Activity ${index}: inspecting workflow configuration`,
        },
      }),
    ).join("\n") + "\n",
  );
}
for (const run of runs)
  for (const check of run.validation ?? []) {
    check.log = join(directory, `${run.id}-validation.log`);
    await writeFile(
      check.log,
      "FAIL permissions.test.ts\nExpected access denied; received 200\n",
    );
  }
if (scenario === "empty") source.runs = async () => [];
else if (scenario === "offline")
  source.runs = async () => {
    throw new Error("Database temporarily unavailable (mock)");
  };
else if (scenario === "stale") {
  let offline = false;
  source.runs = async () => {
    if (offline) throw new Error("Database connection lost (mock)");
    return runs;
  };
  timers.push(
    setTimeout(() => {
      offline = true;
    }, 1500),
  );
} else if (scenario === "pending")
  source.request = async () => "mock-command-awaiting-runner";
else if (scenario === "long-error")
  runs[0] = {
    ...runs[1]!,
    id: "long-error",
    taskKey: "long-error",
    executions: [{ ...runs[1]!.executions![0]!, id: "long-error-execution" }],
    error: `Error: ${"Provider diagnostic context. ".repeat(80)}tail marker\nUnderlying cause recorded here`,
  };
else if (scenario !== "mixed")
  throw new Error(`Unknown demo scenario: ${scenario}`);
try {
  await render(<Monitor source={source} />, {
    alternateScreen: true,
  }).waitUntilExit();
} finally {
  for (const timer of timers) clearTimeout(timer);
  await rm(directory, { recursive: true, force: true });
}
