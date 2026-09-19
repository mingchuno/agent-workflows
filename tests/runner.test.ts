import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configSchema } from "../src/config.js";
import { Runner } from "../src/runner.js";
import { repository } from "./fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

import { agent, FixtureHosting, waitFor } from "./runner-fixtures.js";

test("public runner completes durable issue-to-review workflow and deduplicates polling", {
  skip: !databaseUrl,
}, async () => {
  const { project } = await repository();
  const hosting = new FixtureHosting();
  const config = configSchema.parse({
    id: "test_" + randomUUID().replaceAll("-", ""),
    stateDirectory: await mkdtemp(join(tmpdir(), "aw-artifacts-")),
    projects: [project],
  });
  const runner = new Runner({
    config,
    databaseUrl: databaseUrl!,
    hosting: () => hosting,
    agents: { codex: agent, copilot: agent },
  });
  try {
    await runner.start();
    await waitFor(async () => {
      const runs = await runner.store.runs();
      return (
        !!runs.length &&
        runs.every((r) => !["running", "queued"].includes(r.outcome))
      );
    });
    const runs = await runner.store.runs();
    assert.equal(runs[0]?.outcome, "completed", JSON.stringify(runs));
    assert.equal(hosting.changes.length, 1);
    assert.equal(hosting.reviews.length, 1);
    const sessions = await runner.store.invocations(runs[0]!.id);
    assert.equal(sessions.length, 3);
    assert.equal(new Set(sessions.map((s) => s.sessionId)).size, 3);
    await runner.poll();
    assert.equal((await runner.store.runs()).length, 1);
    const { command } = await import("../src/runtime/process.js");
    const configPath = join(config.stateDirectory, "config.json");
    await writeFile(configPath, JSON.stringify(config));
    const status = await command(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "--config",
        configPath,
        "status",
        "--json",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, AGENT_WORKFLOWS_DATABASE_URL: databaseUrl! },
      },
    );
    assert.equal(JSON.parse(status.stdout).runs[0].id, runs[0]!.id);
  } finally {
    await runner.shutdown();
  }
});
