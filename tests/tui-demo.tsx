/** Manual terminal fixture: node --import tsx tests/tui-demo.tsx */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { Monitor } from "../src/tui/index.js";
import { monitorFixture } from "./tui-fixtures.js";

const { source, run, sessions } = monitorFixture();
const directory = await mkdtemp(join(tmpdir(), "aw-monitor-demo-"));
run.issue.title = "Load CLI environment files for runner and workflow steps";
run.issue.number = 3;
run.executions![0]!.startedAt = new Date(Date.now() - 137000).toISOString();
run.createdAt = run.executions![0]!.createdAt = new Date(
  Date.now() - 145000,
).toISOString();
sessions[0]!.log = join(directory, "agent.jsonl");
await writeFile(
  sessions[0]!.log,
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
source.runs = async () => [
  run,
  {
    ...run,
    id: "failed",
    issue: {
      ...run.issue,
      number: 2,
      title: "Publish validated change request",
    },
    outcome: "failed",
    phase: "change-request",
    error:
      "Resource not accessible by personal access token. Check repository permissions before recovery.",
    executions: [
      {
        ...run.executions![0]!,
        outcome: "failed",
        finishedAt: new Date().toISOString(),
      },
    ],
  },
];
source.request = async () => {
  throw new Error("Read-only demonstration; no workflow actions are sent");
};
try {
  await render(<Monitor source={source} />, {
    alternateScreen: true,
  }).waitUntilExit();
} finally {
  await rm(directory, { recursive: true, force: true });
}
