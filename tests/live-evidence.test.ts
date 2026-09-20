import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { SDKAgent } from "../src/adapters/agents.js";
import { reviewSchema } from "../src/domain.js";
import { repository } from "./fixtures.js";

for (const provider of ["codex", "copilot"] as const) {
  test(`live ${provider} reads evidence outside the checkout with inspection permissions`, {
    skip:
      !process.env.AGENT_WORKFLOWS_LIVE_AGENTS?.split(",").includes(provider),
    timeout: 120_000,
  }, async () => {
    const { root } = await repository();
    const directory = await mkdtemp(join(tmpdir(), "live-evidence-"));
    const file = join(directory, "evidence.txt");
    const nonce = randomUUID();
    await writeFile(file, nonce);
    const events: unknown[] = [];
    try {
      const output = await new SDKAgent(provider).invoke({
        id: randomUUID(),
        runId: randomUUID(),
        step: "evidence-smoke",
        cwd: root,
        prompt: `Read the file at ${file} using file reading tools, without modifying anything. Return only JSON with complete=true, limitations=[], summary containing ONLY the exact file content, and findings=[].`,
        profile: { provider },
        readOnly: true,
        timeoutMs: 110_000,
        signal: AbortSignal.timeout(110_000),
        outputSchema: z.toJSONSchema(reviewSchema),
        session: async () => {},
        event: async (event) => {
          events.push(event);
        },
      });
      assert.equal(reviewSchema.parse(JSON.parse(output)).summary, nonce);
    } catch (error) {
      await writeFile(
        join(tmpdir(), `agent-workflows-live-${provider}.json`),
        JSON.stringify(events, null, 2),
        { mode: 0o600 },
      );
      throw error;
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
      await rm(root + "-remote", { recursive: true, force: true });
    }
  });
}
