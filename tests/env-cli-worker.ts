// Run the real CLI startup, then exercise SDK caller inheritance without a database.
import assert from "node:assert/strict";
import { join } from "node:path";
import { SDKAgent } from "../src/adapters/agents.js";
import type { AgentInvocation } from "../src/domain.js";
import { command } from "../src/runtime/process.js";

await import("../src/cli.js");
assert.ok(!process.exitCode);
const invocation: AgentInvocation = {
  id: "fixture",
  runId: "fixture",
  step: "implementation",
  cwd: process.cwd(),
  prompt: "Implement task",
  profile: { provider: "codex" },
  readOnly: false,
  signal: new AbortController().signal,
  session: async () => {},
  event: async () => {},
};
const agent = new SDKAgent("codex");
await agent.invoke(invocation);
await command(
  process.execPath,
  [join(process.cwd(), "env-child.mjs"), "validation"],
  { cwd: process.cwd() },
);
await assert.rejects(
  agent.invoke({
    ...invocation,
    prompt: "Return commitMessage",
    readOnly: true,
  }),
);
