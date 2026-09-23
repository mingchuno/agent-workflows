import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type ChangeEvidence,
  captureEvidence,
  evidenceLimits,
} from "../src/evidence.js";
import { EvidenceQuery } from "../src/evidence-query.js";
import { ExistingCheckout } from "../src/workspace.js";
import { repository } from "./fixtures.js";

async function capturedEvidence(): Promise<ChangeEvidence> {
  const { root, project } = await repository();
  await writeFile(
    join(root, "large.txt"),
    `${"first line\n".repeat(7_000)}${"x".repeat(1_000)}needle at the end\n`,
  );
  await writeFile(join(root, "other.txt"), "literal needle twice: needle\n");
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  return captureEvidence({
    project,
    directory: await mkdtemp(join(tmpdir(), "query-evidence-")),
    snapshot: await new ExistingCheckout().inspect(project),
  });
}

test("evidence queries paginate changes and report unread chunks and binary metadata", async () => {
  const query = new EvidenceQuery(await capturedEvidence());
  const first = await query.list({ page: 1, pageSize: 2 });
  assert.equal(first.changes.length, 2);
  assert.equal(first.page, 1);
  assert.equal(first.nextPage, 2);
  assert.ok(first.unreadChunks > 1);

  const large = first.changes.find((change) => change.path === "large.txt");
  assert.ok(large);
  assert.ok(large.chunks.length > 1);
  assert.deepEqual(
    large.unreadChunks,
    large.chunks.map((chunk) => chunk.ordinal),
  );

  const read = await query.read({
    reference: large.reference,
    chunk: large.chunks[0]!.ordinal,
  });
  assert.ok(Buffer.byteLength(read.text) <= evidenceLimits.chunkBytes);
  assert.equal(read.remainingUnreadChunks, large.chunks.length - 1);

  const after = await query.list({ page: 1, pageSize: 2 });
  assert.equal(after.unreadChunks, first.unreadChunks - 1);
  assert.deepEqual(
    after.changes.find((change) => change.reference === large.reference)
      ?.unreadChunks,
    large.chunks.slice(1).map((chunk) => chunk.ordinal),
  );

  const second = await query.list({ page: 2, pageSize: 2 });
  const binary = [...first.changes, ...second.changes].find(
    (change) => change.path === "binary.bin",
  );
  assert.equal(binary?.binary, true);
  assert.equal(binary?.chunks.length, 0);
  assert.match(binary?.reason ?? "", /metadata only/i);
});

test("literal search returns bounded manifest locations and distinguishes no matches", async () => {
  const query = new EvidenceQuery(await capturedEvidence());
  const result = await query.search({ term: "needle", limit: 2 });
  assert.equal(result.matches.length, 2);
  assert.equal(result.limit, 2);
  assert.equal(result.truncated, true);
  assert.ok(result.matches.every((match) => match.preview.includes("needle")));
  assert.ok(
    result.matches.every((match) => match.line > 0 && match.column > 0),
  );
  assert.ok(
    result.matches.every((match) => match.reference.startsWith("change-")),
  );

  const absent = await query.search({ term: "not present" });
  assert.deepEqual(absent.matches, []);
  assert.equal(absent.truncated, false);
  assert.ok(absent.searchedChanges > 0);
  assert.ok(absent.binaryChanges > 0);
});

test("evidence queries reject absent pages, references, chunks, and modified artifacts", async () => {
  const evidence = await capturedEvidence();
  const query = new EvidenceQuery(evidence);
  await assert.rejects(query.list({ page: 99 }), /page 99 is absent/i);
  await assert.rejects(
    query.read({ reference: "change-999", chunk: 0 }),
    /reference.*absent/i,
  );
  const listed = await query.list({ page: 1, pageSize: 10 });
  await assert.rejects(
    query.read({ reference: listed.changes[0]!.reference, chunk: 999 }),
    /chunk 999 is absent/i,
  );
  await assert.rejects(query.search({ term: "" }), /term/i);

  const artifact = evidence.files.find((file) => file.path !== evidence.index)!;
  await writeFile(artifact.path, `${await readFile(artifact.path, "utf8")}x`);
  await assert.rejects(query.list({}), /evidence changed/i);
});
