import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { RunRecord } from "../src/domain.js";
import { command } from "../src/runtime/process.js";
import { repository } from "./fixtures.js";

for (const phase of [
  "edits",
  "commit",
  "push",
  "change-request",
  "review",
  "publication-admitted",
  "publication-forked",
  "publication-effect",
])
  test(`restart reconciles interruption after ${phase} without duplicate effects`, {
    skip: !process.env.TEST_DATABASE_URL,
  }, async () => {
    const { project, git } = await repository();
    const directory = await mkdtemp(join(tmpdir(), "aw-recovery-"));
    const config = join(directory, "config.json"),
      external = join(directory, "external.json");
    await writeFile(
      config,
      JSON.stringify({
        id: "recovery_" + randomUUID().replaceAll("-", ""),
        stateDirectory: directory,
        projects: [project],
      }),
    );
    await writeFile(external, JSON.stringify({ changes: [], reviews: [] }));
    const args = [
      "--import",
      "tsx",
      resolve("tests/recovery-worker.ts"),
      config,
      external,
    ];
    const interrupted = await command(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env, FAULT_PHASE: phase },
      allowFailure: true,
      timeoutMs: 30000,
    });
    assert.equal(
      interrupted.exitCode,
      77,
      interrupted.stderr + interrupted.stdout,
    );
    if (phase === "publication-admitted") {
      // Admission is durable even when the runner dies before dispatch. Resume
      // intake through a queued command, just as an operator would after restart.
      const { Store } = await import("../src/store.js");
      const saved = JSON.parse(await readFile(config, "utf8"));
      const store = new Store(process.env.TEST_DATABASE_URL!, saved.id);
      try {
        assert.equal(
          (await store.commands()).find((item) => item.kind === "recover")
            ?.status,
          "pending",
        );
        await store.request("resume", project.id);
      } finally {
        await store.close();
      }
    }
    const resumed = await command(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env, FAULT_PHASE: "" },
      allowFailure: true,
      timeoutMs: 30000,
    });
    assert.equal(resumed.exitCode, 0, resumed.stderr + resumed.stdout);
    const result = JSON.parse(
      await readFile(join(directory, "result.json"), "utf8"),
    ) as { runs: RunRecord[]; sessions: unknown[] };
    const effects = JSON.parse(await readFile(external, "utf8")) as {
      changes: unknown[];
      reviews: unknown[];
    };
    assert.equal(
      result.runs[0]!.outcome,
      phase === "edits" ? "blocked" : "completed",
      JSON.stringify(result.runs),
    );
    assert.equal(effects.changes.length, phase === "edits" ? 0 : 1);
    assert.equal(effects.reviews.length, phase === "edits" ? 0 : 1);
    assert.equal(
      Number((await git("rev-list", "--count", "HEAD")).stdout.trim()),
      phase === "edits" ? 1 : 2,
    );
    assert.equal(result.sessions.length, phase === "edits" ? 1 : 3);
    if (phase.startsWith("publication-")) {
      assert.equal(result.runs.length, 1);
      assert.equal(result.runs[0]!.executions?.length, 2);
      assert.equal(result.runs[0]!.executions?.[0]?.outcome, "failed");
      assert.equal(result.runs[0]!.executions?.[1]?.outcome, "completed");
    }
  });

test("restart blocks a changed checkout registration without changing replay order", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const original = await repository(),
    replacement = await repository();
  const directory = await mkdtemp(join(tmpdir(), "aw-recovery-"));
  const path = join(directory, "config.json"),
    external = join(directory, "external.json");
  const config = {
    id: "recovery_" + randomUUID().replaceAll("-", ""),
    stateDirectory: directory,
    projects: [original.project],
  };
  await writeFile(path, JSON.stringify(config));
  await writeFile(external, JSON.stringify({ changes: [], reviews: [] }));
  const args = [
    "--import",
    "tsx",
    resolve("tests/recovery-worker.ts"),
    path,
    external,
  ];
  assert.equal(
    (
      await command(process.execPath, args, {
        cwd: process.cwd(),
        env: { ...process.env, FAULT_PHASE: "push" },
        allowFailure: true,
        timeoutMs: 30000,
      })
    ).exitCode,
    77,
  );
  config.projects[0] = { ...replacement.project, id: original.project.id };
  await writeFile(path, JSON.stringify(config));
  const resumed = await command(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, FAULT_PHASE: "" },
    allowFailure: true,
    timeoutMs: 30000,
  });
  assert.equal(resumed.exitCode, 0, resumed.stderr);
  const result = JSON.parse(
    await readFile(join(directory, "result.json"), "utf8"),
  );
  assert.equal(result.runs[0].outcome, "blocked");
  assert.match(result.runs[0].error, /checkout differs/);
  assert.equal(
    Number(
      (await replacement.git("rev-list", "--count", "HEAD")).stdout.trim(),
    ),
    1,
  );
});
