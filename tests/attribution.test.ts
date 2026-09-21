import assert from "node:assert/strict";
import { test } from "node:test";
import {
  contributingProviders,
  finalizeCommitMessage,
} from "../src/attribution.js";
import { projectSchema } from "../src/config.js";
import type { Snapshot } from "../src/domain.js";

const project = projectSchema.parse({
  id: "fixture",
  checkout: "/tmp",
  hosting: {
    provider: "github",
    origin: "https://github.com",
    repository: "a/b",
    tokenEnv: "TOKEN",
  },
  agent: { provider: "codex" },
});
const snapshot = (files: Snapshot["files"]): Snapshot => ({
  branch: "agent/1",
  head: "base",
  fingerprint: JSON.stringify(files),
  diff: "",
  paths: Object.keys(files),
  files,
});

test("contributors are retained once in first-contribution order", () => {
  const final = snapshot({ "a.txt": "a", "b.txt": "b", "undone.txt": null });
  assert.deepEqual(
    contributingProviders(
      [
        {
          provider: "copilot",
          beforeFiles: {},
          afterFiles: { "a.txt": "a" },
        },
        {
          provider: "codex",
          beforeFiles: { "a.txt": "a" },
          afterFiles: { "a.txt": "a", "b.txt": "b" },
        },
        {
          provider: "copilot",
          beforeFiles: { "undone.txt": null },
          afterFiles: { "undone.txt": "temporary" },
        },
      ],
      final,
    ),
    ["copilot", "codex"],
  );
});

test("commit finalization preserves trailers and deduplicates agent attribution and run marker", () => {
  const publication = finalizeCommitMessage(
    {
      commitMessage:
        "feat: change\n\nSigned-off-by: Human <human@example.com>\nCo-authored-by: Codex <noreply@openai.com>\nCo-authored-by: Codex <noreply@openai.com>\nAgent-Workflows-Run: stale",
      title: "Change",
      description: "Description",
    },
    project,
    ["codex", "copilot"],
    "run-1",
  );
  assert.equal(
    publication.commitMessage,
    "feat: change\n\nSigned-off-by: Human <human@example.com>\nCo-authored-by: Codex <noreply@openai.com>\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>\nAgent-Workflows-Run: run-1",
  );
});

test("disabled attribution leaves pre-existing co-author trailers intact", () => {
  const publication = finalizeCommitMessage(
    {
      commitMessage:
        "feat: change\n\nCo-authored-by: Codex <noreply@openai.com>",
      title: "Change",
      description: "Description",
    },
    { ...project, includeAgentCoAuthors: false },
    ["codex"],
    "run-1",
  );
  assert.match(publication.commitMessage, /Co-authored-by: Codex/);
});
