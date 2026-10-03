import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { SDKAgent } from "../src/adapters/agents.js";
import { publicationSchema, reviewSchema } from "../src/domain.js";
import { repository } from "./fixtures.js";

for (const provider of ["codex", "copilot"] as const) {
  test(`live ${provider} inspects through commands and resumes publication across workers`, {
    skip:
      !process.env.AGENT_WORKFLOWS_LIVE_AGENTS?.split(",").includes(provider),
    timeout: 360_000,
  }, async () => {
    const { root, git } = await repository();
    const adapter = new SDKAgent(provider);
    const nonce = randomUUID();
    const events: unknown[] = [];
    const base = (await git("rev-parse", "HEAD")).stdout.trim();
    let implementationSession = "";
    const invoke = (
      prompt: string,
      outputSchema?: unknown,
      resumeSessionId?: string,
    ) =>
      adapter.invoke({
        id: randomUUID(),
        runId: "live-stages",
        step: "live-stage",
        cwd: root,
        prompt,
        profile: { provider },
        resumeSessionId,
        outputSchema,
        timeoutMs: 110_000,
        signal: AbortSignal.timeout(110_000),
        session: async (id) => {
          if (resumeSessionId) assert.equal(id, resumeSessionId);
          else if (!implementationSession) implementationSession = id;
          else assert.notEqual(id, implementationSession);
        },
        event: async (event) => {
          events.push(event);
        },
      });
    try {
      await invoke(
        `Use a shell command to create implemented.txt containing exactly ${nonce}. Do not commit. Report when done.`,
      );
      assert.ok(implementationSession);
      assert.equal(
        (await readFile(join(root, "implemented.txt"), "utf8")).trim(),
        nonce,
      );
      const publication = publicationSchema.parse(
        JSON.parse(
          await invoke(
            "Use shell commands to inspect git status and untracked implemented.txt. Return only JSON with commitMessage, title and description. Set description to ONLY the exact trimmed file content. Preserve the checkout and do not commit.",
            z.toJSONSchema(publicationSchema),
            implementationSession,
          ),
        ),
      );
      assert.equal(publication.description, nonce);
      await git("add", "implemented.txt");
      await git("commit", "-m", "live fixture");
      const head = (await git("rev-parse", "HEAD")).stdout.trim();
      const review = reviewSchema.parse(
        JSON.parse(
          await invoke(
            `Use shell commands to inspect git diff ${base} ${head} and git show ${head}:implemented.txt. Return only JSON with complete=true, limitations=[], findings=[], summary containing ONLY the exact trimmed file content. Preserve the checkout.`,
            z.toJSONSchema(reviewSchema),
          ),
        ),
      );
      assert.equal(review.summary, nonce);
      assert.equal((await git("status", "--porcelain")).stdout, "");
    } catch (error) {
      await writeFile(
        join(tmpdir(), `agent-workflows-live-${provider}.json`),
        JSON.stringify(events, null, 2),
        { mode: 0o600 },
      );
      throw error;
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(root + "-remote", { recursive: true, force: true });
    }
  });
}
