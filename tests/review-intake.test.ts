import assert from "node:assert/strict";
import { test } from "node:test";
import { projectSchema } from "../src/config.js";
import type { ReviewRequest } from "../src/domain.js";
import {
  reviewEligible,
  reviewTaskKey,
  sameReviewRevision,
} from "../src/review-intake.js";

const project = projectSchema.parse({
  id: "review",
  checkout: "/tmp",
  hosting: {
    provider: "github",
    origin: "https://github.com",
    repository: "a/b",
    tokenEnv: "TOKEN",
  },
  agent: { provider: "codex" },
  workflows: {
    implementation: { enabled: false },
    review: { enabled: true, labels: ["review", "ready"] },
  },
});
const request: ReviewRequest = {
  id: "42",
  number: 1,
  title: "Review",
  body: "",
  url: "https://github.com/a/b/pull/1",
  labels: ["review", "ready"],
  open: true,
  draft: false,
  fork: false,
  sourceBranch: "feature",
  targetBranch: "main",
  base: "base",
  start: "start",
  change: { id: 1, url: "https://github.com/a/b/pull/1", head: "head" },
};
test("review eligibility excludes drafts, forks, closed and partially labelled requests", () => {
  assert.equal(reviewEligible(request, project), true);
  for (const override of [
    { draft: true },
    { fork: true },
    { open: false },
    { labels: ["review"] },
  ])
    assert.equal(reviewEligible({ ...request, ...override }, project), false);
});
test("new push admission is opt-in and revision freshness includes the target diff", () => {
  const pushed = { ...request, change: { ...request.change, head: "new" } };
  assert.equal(
    reviewTaskKey("host", project, request),
    reviewTaskKey("host", project, pushed),
  );
  const enabled = {
    ...project,
    workflows: {
      ...project.workflows,
      review: { ...project.workflows.review, rereviewOnPush: true },
    },
  };
  assert.notEqual(
    reviewTaskKey("host", enabled, request),
    reviewTaskKey("host", enabled, pushed),
  );
  assert.equal(sameReviewRevision(request, pushed), false);
  assert.equal(
    sameReviewRevision(request, { ...request, base: "changed-base" }),
    false,
  );
  assert.equal(
    sameReviewRevision(request, { ...request, start: "changed-target" }),
    false,
  );
});

test("completed reviews deduplicate only the same project and request URL", async () => {
  const { alreadyReviewed } = await import("../src/review-intake.js");
  const { createQueuedReviewRun } = await import("../src/run-record.js");
  const run = createQueuedReviewRun({
    id: "run",
    projectId: project.id,
    checkout: project.checkout,
    taskKey: "task",
    attempt: 1,
    now: new Date().toISOString(),
    request,
  });
  run.outcome = "completed";
  run.review = {
    complete: true,
    limitations: [],
    summary: "Reviewed",
    findings: [],
  };
  run.reviewHead = request.change.head;
  assert.equal(alreadyReviewed([run], project, request), true);
  assert.equal(
    alreadyReviewed([run], project, {
      ...request,
      change: {
        ...request.change,
        url: "https://github.com/other/repo/pull/1",
      },
    }),
    false,
  );
  assert.equal(
    alreadyReviewed([{ ...run, outcome: "failed" }], project, request),
    false,
  );
  assert.equal(
    alreadyReviewed([{ ...run, projectId: "other" }], project, request),
    false,
  );
});
