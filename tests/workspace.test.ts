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
      commitMessage: "feat: generated\n\nAgent-Workflows-Run: run-1",
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
test("commit uses native distinct Git author and committer identities", async () => {
  const { root, project, git } = await repository();
  await git("config", "author.name", "Native Author");
  await git("config", "author.email", "author@example.com");
  await git("config", "committer.name", "Native Committer");
  await git("config", "committer.email", "committer@example.com");
  const workspace = new ExistingCheckout();
  await workspace.prepare(project, "agent/native-identity");
  await writeFile(join(root, "native.txt"), "native identity\n");
  const snapshot = await workspace.inspect(project);
  await workspace.commit(
    project,
    snapshot,
    {
      commitMessage: "feat: native identity\n\nAgent-Workflows-Run: native",
      title: "Native identity",
      description: "Uses Git identity selection.",
    },
    "native",
  );
  assert.equal(
    (await git("log", "-1", "--format=%an|%ae|%cn|%ce")).stdout.trim(),
    "Native Author|author@example.com|Native Committer|committer@example.com",
  );
});
test("commit reconciliation requires the finalized message", async () => {
  const { root, project } = await repository();
  const workspace = new ExistingCheckout();
  await workspace.prepare(project, "agent/reconcile");
  await writeFile(join(root, "reconcile.txt"), "reconcile\n");
  const snapshot = await workspace.inspect(project);
  const publication = {
    commitMessage:
      "feat: reconcile\n\nCo-authored-by: Codex <noreply@openai.com>\nAgent-Workflows-Run: reconcile",
    title: "Reconcile",
    description: "Reconcile the commit effect.",
  };
  const head = await workspace.commit(
    project,
    snapshot,
    publication,
    "reconcile",
  );
  assert.equal(
    await workspace.commit(project, snapshot, publication, "reconcile"),
    head,
  );
  await assert.rejects(
    workspace.commit(
      project,
      snapshot,
      { ...publication, commitMessage: "feat: different" },
      "reconcile",
    ),
    /workflow run marker/,
  );
});
test("commit reports Git's error when native identity is unavailable", async () => {
  const { root, project, git } = await repository();
  await git("config", "--unset", "user.name");
  await git("config", "--unset", "user.email");
  const workspace = new ExistingCheckout();
  await workspace.prepare(project, "agent/missing-identity");
  await writeFile(join(root, "identity.txt"), "identity\n");
  const snapshot = await workspace.inspect(project);
  const names = [
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
    "EMAIL",
  ] as const;
  const prior = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  for (const name of names) process.env[name] = "";
  try {
    await assert.rejects(
      workspace.commit(
        project,
        snapshot,
        {
          commitMessage:
            "feat: require identity\n\nAgent-Workflows-Run: missing-identity",
          title: "Require identity",
          description: "Let Git select or reject identity.",
        },
        "missing-identity",
      ),
      /Author identity unknown|empty ident name/,
    );
  } finally {
    for (const name of names) {
      const value = prior[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
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

test("cancelling a Git push stops its hook before checkout reuse", async () => {
  const { waitFor } = await import("./runner-fixtures.js");
  const { assertProcessesStopped } = await import(
    "../src/runtime/ownership.js"
  );
  const { root, project, git } = await repository();
  const ready = join(root, ".git", "push-ready");
  await writeFile(
    join(root, ".git", "hooks", "pre-push"),
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(ready)}, "ready");\nsetInterval(() => {}, 1000);\n`,
    { mode: 0o700 },
  );
  const workspace = new ExistingCheckout();
  const controller = new AbortController();
  const head = (await git("rev-parse", "HEAD")).stdout.trim();
  const pushing = workspace.push(
    project,
    "agent/cancelled",
    head,
    controller.signal,
  );
  const cancelled = assert.rejects(pushing, /cancelled/);
  try {
    await waitFor(async () =>
      readFile(ready, "utf8").then(
        () => true,
        () => false,
      ),
    );
    controller.abort();
    await cancelled;
    await assertProcessesStopped(
      join(root, ".git", "agent-workflows-processes"),
    );
    await workspace.check(project);
    assert.equal(
      (
        await git(
          "ls-remote",
          "--heads",
          "origin",
          "refs/heads/agent/cancelled",
        )
      ).stdout.trim(),
      "",
    );
  } finally {
    controller.abort();
    await cancelled;
  }
});
