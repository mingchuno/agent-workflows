import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { command } from "../src/runtime/process.js";
import { ExistingCheckout } from "../src/workspace.js";

import { repository } from "./fixtures.js";

test("workspace preserves dirty files and refuses conflicting branches", async () => {
  const { root, project } = await repository();
  const workspace = new ExistingCheckout();
  await writeFile(join(root, "file.txt"), "unfinished");
  await assert.rejects(workspace.prepare(project, "agent/1"), /clean/);
  assert.equal(await readFile(join(root, "file.txt"), "utf8"), "unfinished");
  await writeFile(join(root, "file.txt"), "base\n");
  await workspace.prepare(project, "agent/1");
  await assert.rejects(workspace.prepare(project, "agent/1"), /exists/);
});
test("verified commit uses generated text and next branch starts at configured base", async () => {
  const { root, project, git } = await repository();
  const workspace = new ExistingCheckout();
  const base = await workspace.prepare(project, "agent/1");
  await writeFile(join(root, "new.txt"), "implementation");
  const snapshot = await workspace.inspect(project);
  const head = await workspace.commit(
    project,
    snapshot,
    {
      commitMessage: "feat: generated",
      title: "Title",
      description: "Description",
    },
    "run-1",
  );
  await workspace.push(project, "agent/1", head);
  await workspace.release(project);
  assert.match(
    (await git("log", "-1", "--format=%B")).stdout,
    /feat: generated/,
  );
  assert.equal((await workspace.prepare(project, "agent/2")).head, base.head);
});
test("cancellation waits for a stubborn process to terminate", async () => {
  const abort = new AbortController();
  const running = command(
    process.execPath,
    ["-e", 'process.on("SIGTERM",()=>{}); setInterval(()=>{},100)'],
    { cwd: tmpdir(), signal: abort.signal, killGraceMs: 50 },
  );
  setTimeout(() => abort.abort(), 200);
  await assert.rejects(running, /cancelled/);
});

test("workspace blocks unresolved Git operations and unexpected changes", async () => {
  const { project, root, git } = await repository();
  const workspace = new ExistingCheckout();
  await writeFile(
    join(root, ".git", "MERGE_HEAD"),
    (await git("rev-parse", "HEAD")).stdout,
  );
  await assert.rejects(
    workspace.prepare(project, "agent/1"),
    /Unresolved Git operation/,
  );
  const { unlink } = await import("node:fs/promises");
  await unlink(join(root, ".git", "MERGE_HEAD"));
  const snapshot = await workspace.prepare(project, "agent/1");
  await writeFile(join(root, "file.txt"), "unexpected");
  await assert.rejects(
    workspace.verify(project, snapshot),
    /Unexpected checkout mutation/,
  );
});
