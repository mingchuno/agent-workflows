import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertProcessesStopped,
  CheckoutOwnership,
} from "../src/runtime/ownership.js";
import { command } from "../src/runtime/process.js";
import { repository } from "./fixtures.js";

test("checkout ownership rejects a second local owner independently of database", async () => {
  const { root } = await repository();
  const artifacts = await mkdtemp(join(tmpdir(), "aw-ownership-"));
  const first = new CheckoutOwnership(),
    second = new CheckoutOwnership();
  try {
    await first.acquire(root, artifacts);
    await assert.rejects(second.acquire(root, artifacts), /owned by process/);
  } finally {
    await first.release();
  }
  await second.acquire(root, artifacts);
  await second.release();
});
test("process journal blocks recovery until a real process group has stopped", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aw-process-"));
  const controller = new AbortController();
  let ready!: () => void;
  const started = new Promise<void>((resolve) => (ready = resolve));
  const running = command(
    process.execPath,
    [
      "-e",
      'console.log("ready"); process.on("SIGTERM",()=>{}); setInterval(()=>{},100)',
    ],
    {
      cwd: directory,
      processFile: join(directory, "worker.process.json"),
      signal: controller.signal,
      killGraceMs: 50,
      onOutput: () => ready(),
    },
  );
  await started;
  await assert.rejects(assertProcessesStopped(directory), /still alive/);
  controller.abort();
  await assert.rejects(running, /cancelled/);
  await assertProcessesStopped(directory);
});

test("recovery refuses checkout ownership while a crashed runner's Git push survives", async () => {
  const { spawn } = await import("node:child_process");
  const { readFile, writeFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const { waitFor } = await import("./runner-fixtures.js");
  const { root, project } = await repository();
  const directory = await mkdtemp(join(tmpdir(), "aw-git-owner-"));
  const config = join(directory, "project.json");
  const ready = join(directory, "ready");
  await writeFile(config, JSON.stringify(project));
  await writeFile(
    join(root, ".git", "hooks", "pre-push"),
    '#!/bin/sh\nps -o pgid= -p $$ > "$AW_PUSH_READY"\nwhile :; do sleep 1; done\n',
    { mode: 0o700 },
  );
  const child = spawn(
    process.execPath,
    ["--import", "tsx", resolve("tests/git-push-worker.ts"), config, directory],
    {
      stdio: "ignore",
      env: { ...process.env, AW_PUSH_READY: ready },
    },
  );
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  let group: number | undefined;
  const replacement = new CheckoutOwnership();
  try {
    await waitFor(async () => {
      try {
        group = Number((await readFile(ready, "utf8")).trim());
        return !!group;
      } catch {
        return false;
      }
    });
    child.kill("SIGKILL");
    await exited;
    await assert.rejects(replacement.acquire(root, directory), /still alive/);
  } finally {
    child.kill("SIGKILL");
    await exited;
    if (group) {
      try {
        process.kill(-group, "SIGKILL");
      } catch {}
    }
    await replacement.release();
  }
});
