import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  captureEvidence,
  chunkText,
  evidenceLimits,
  verifyEvidence,
} from "../src/evidence.js";
import { ExistingCheckout } from "../src/workspace.js";
import { repository } from "./fixtures.js";

test("UTF-8 chunks are bounded and reconstruct long lines without loss", () => {
  const text = "😀".repeat(40000) + "\nend";
  const chunks = chunkText(text);
  assert.equal(chunks.join(""), text);
  assert.ok(
    chunks.every(
      (part) => Buffer.byteLength(part) <= evidenceLimits.chunkBytes,
    ),
  );
});
test("publication captures staged, unstaged, untracked and binary evidence outside checkout", async () => {
  const { root, project, git } = await repository();
  await writeFile(join(root, "file.txt"), "staged\n");
  await git("add", "file.txt");
  await writeFile(join(root, "file.txt"), "unstaged\n");
  await writeFile(join(root, "new.txt"), "new content\n");
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  const snapshot = await new ExistingCheckout().inspect(project);
  const directory = await mkdtemp(join(tmpdir(), "evidence-"));
  const evidence = await captureEvidence({ project, directory, snapshot });
  await verifyEvidence(evidence);
  const text = (
    await Promise.all(evidence.files.map((file) => readFile(file.path, "utf8")))
  ).join("\n");
  assert.match(text, /staged/);
  assert.match(text, /unstaged/);
  assert.match(text, /new content/);
  assert.match(text, /binary/);
  await writeFile(evidence.files[0]!.path, "tampered");
  await assert.rejects(verifyEvidence(evidence), /evidence/i);
});

test("published evidence is bound to revisions even when other source exists", async () => {
  const { root, project, git } = await repository();
  const base = (await git("rev-parse", "HEAD")).stdout.trim();
  await writeFile(join(root, "file.txt"), "published text\n");
  await git("add", "file.txt");
  await git("commit", "-m", "published");
  const head = (await git("rev-parse", "HEAD")).stdout.trim();
  await writeFile(join(root, "file.txt"), "later text\n");
  const snapshot = await new ExistingCheckout().inspect(project);
  const evidence = await captureEvidence({
    project,
    snapshot,
    directory: await mkdtemp(join(tmpdir(), "review-evidence-")),
    revisions: { base, head },
  });
  const text = (
    await Promise.all(evidence.files.map((file) => readFile(file.path, "utf8")))
  ).join("\n");
  assert.match(text, /published text/);
  assert.doesNotMatch(text, /later text/);
  assert.equal(evidence.base, base);
  assert.equal(evidence.head, head);
});
test("artifact budget includes index and rejects overflow without truncation", async () => {
  const { EvidenceWriter } = await import("../src/evidence.js");
  const directory = await mkdtemp(join(tmpdir(), "budget-evidence-"));
  const writer = new EvidenceWriter(directory);
  const text = "x".repeat(evidenceLimits.chunkBytes);
  for (
    let i = 0;
    i < evidenceLimits.totalBytes / evidenceLimits.chunkBytes;
    i++
  )
    await writer.write(`chunk-${i}`, text);
  await assert.rejects(
    writer.write("index.json", "{}"),
    /33554434 bytes exceeds limit 33554432/,
  );
  assert.equal(writer.files.length, 512);
});
test("capture refuses an evidence directory in source without creating it", async () => {
  const { access } = await import("node:fs/promises");
  const { root, project } = await repository();
  const directory = join(root, "must-not-create");
  await assert.rejects(
    captureEvidence({
      project,
      directory,
      snapshot: await new ExistingCheckout().inspect(project),
    }),
    /outside/,
  );
  await assert.rejects(access(directory));
});

test("large indexes paginate their own catalog without losing entries", async () => {
  const { EvidenceWriter } = await import("../src/evidence.js");
  const directory = await mkdtemp(join(tmpdir(), "large-index-evidence-"));
  const writer = new EvidenceWriter(directory);
  const contents =
    JSON.stringify({ path: "x".repeat(25 * 1024 * 1024) }) + "\n";
  const index = await writer.index(contents, { changedPaths: 1 });
  const root = JSON.parse(await readFile(index.path, "utf8"));
  assert.ok(root.indexDepth > 0);
  let pages = root.pages as Array<{ path: string }>;
  for (let depth = root.indexDepth; depth > 0; depth--)
    pages = JSON.parse(
      (
        await Promise.all(pages.map((page) => readFile(page.path, "utf8")))
      ).join(""),
    );
  assert.equal(
    (await Promise.all(pages.map((page) => readFile(page.path, "utf8")))).join(
      "",
    ),
    contents,
  );
  assert.ok(
    writer.files.every((file) => file.bytes <= evidenceLimits.chunkBytes),
  );
});
