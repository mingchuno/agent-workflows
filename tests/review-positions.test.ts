import assert from "node:assert/strict";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { prepareReviewPositions } from "../src/review-positions.js";
import { repository } from "./fixtures.js";

for (const path of [
  "new.txt",
  "new space.txt",
  'quoted\t"é.txt',
  "new\nline.txt",
  "control\x01.txt",
]) {
  test(`review positions retain rename origins and added lines for ${JSON.stringify(path)}`, async () => {
    const { root, git } = await repository();
    try {
      const original = 'old\t"é.txt';
      await writeFile(join(root, original), "unchanged\n".repeat(20));
      await git("add", ".");
      await git("commit", "-m", "base");
      const base = (await git("rev-parse", "HEAD")).stdout.trim();
      await rename(join(root, original), join(root, path));
      await writeFile(
        join(root, path),
        `${"unchanged\n".repeat(20)}+++ b/decoy\nadded\n`,
      );
      await writeFile(join(root, "unrelated.txt"), "unrelated\n");
      await git("add", ".");
      await git("commit", "-m", "rename and append");
      const head = (await git("rev-parse", "HEAD")).stdout.trim();
      // The mutable checkout must not supply publication evidence.
      await writeFile(join(root, path), "uncommitted\n");
      const positions = await prepareReviewPositions({
        checkout: root,
        base,
        head,
        review: {
          complete: true,
          limitations: [],
          summary: "Review",
          findings: [
            { body: "header-like addition", path, line: 21 },
            { body: "second addition", path, line: 22 },
            { body: "context", path, line: 1 },
            { body: "outside diff", path, line: 99 },
            { body: "general", path: null, line: null },
            { body: "missing", path: "missing.txt", line: 1 },
          ],
        },
      });
      assert.deepEqual(positions, {
        inline: [
          { body: "header-like addition", path, oldPath: original, line: 21 },
          { body: "second addition", path, oldPath: original, line: 22 },
        ],
        summaryFindings: ["context", "outside diff", "general", "missing"],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(`${root}-remote`, { recursive: true, force: true });
    }
  });
}

test("review positions send deleted, binary and unlocated findings to the summary", async () => {
  const { root, git } = await repository();
  try {
    const base = (await git("rev-parse", "HEAD")).stdout.trim();
    await rm(join(root, "file.txt"));
    await writeFile(join(root, "binary.dat"), Buffer.from([0, 1, 2]));
    await writeFile(join(root, "-new.txt"), "first\nsecond\n");
    await git("add", ".");
    await git("commit", "-m", "new and deleted files");
    const head = (await git("rev-parse", "HEAD")).stdout.trim();
    const positions = await prepareReviewPositions({
      checkout: root,
      base,
      head,
      review: {
        complete: true,
        limitations: [],
        summary: "Review",
        findings: [
          { body: "new file", path: "-new.txt", line: 2 },
          { body: "duplicate position", path: "-new.txt", line: 2 },
          { body: "deleted", path: "file.txt", line: 1 },
          { body: "binary", path: "binary.dat", line: 1 },
          { body: "unlocated" },
        ],
      },
    });
    assert.deepEqual(positions.inline, [
      { body: "new file", path: "-new.txt", oldPath: "-new.txt", line: 2 },
      {
        body: "duplicate position",
        path: "-new.txt",
        oldPath: "-new.txt",
        line: 2,
      },
    ]);
    assert.deepEqual(positions.summaryFindings, [
      "deleted",
      "binary",
      "unlocated",
    ]);
    await assert.rejects(
      prepareReviewPositions({
        checkout: root,
        base: "missing-revision",
        head,
        review: {
          complete: true,
          limitations: [],
          summary: "Review",
          findings: [{ body: "new", path: "-new.txt", line: 1 }],
        },
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(`${root}-remote`, { recursive: true, force: true });
  }
});

test("review positions use literal paths and exact lines across replacement hunks", async () => {
  const { root, git } = await repository();
  try {
    const path = ":(glob)*.txt";
    await writeFile(
      join(root, path),
      "old\n" + "context\n".repeat(20) + "last",
    );
    await git("add", ".");
    await git("commit", "-m", "base hunks");
    const base = (await git("rev-parse", "HEAD")).stdout.trim();
    await writeFile(
      join(root, path),
      "replacement\n" + "context\n".repeat(20) + "changed",
    );
    await git("add", ".");
    await git("commit", "-m", "two replacements");
    const head = (await git("rev-parse", "HEAD")).stdout.trim();
    await git("config", "diff.noprefix", "true");
    await git("config", "color.ui", "always");
    const positions = await prepareReviewPositions({
      checkout: root,
      base,
      head,
      review: {
        complete: true,
        limitations: [],
        summary: "Review",
        findings: [
          { body: "last replacement", path, line: 22 },
          { body: "first replacement", path, line: 1 },
          { body: "unchanged", path, line: 2 },
        ],
      },
    });
    assert.deepEqual(positions, {
      inline: [
        { body: "last replacement", path, oldPath: path, line: 22 },
        { body: "first replacement", path, oldPath: path, line: 1 },
      ],
      summaryFindings: ["unchanged"],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(`${root}-remote`, { recursive: true, force: true });
  }
});
