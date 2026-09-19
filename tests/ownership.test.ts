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
