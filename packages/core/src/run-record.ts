import type { Issue, ReviewRequest, RunRecord, RunSubject } from "./domain.js";

type QueuedRunInput = Pick<
  RunRecord,
  "id" | "projectId" | "checkout" | "taskKey" | "attempt" | "retryOf"
> & { issue: Issue; now: string; branchTemplate: string };

function queuedRun(
  input: Omit<QueuedRunInput, "issue" | "branchTemplate"> & {
    subject: RunSubject;
    branch: string;
  },
): RunRecord {
  return {
    id: input.id,
    projectId: input.projectId,
    checkout: input.checkout,
    taskKey: input.taskKey,
    attempt: input.attempt,
    ...(input.retryOf === undefined ? {} : { retryOf: input.retryOf }),
    subject: input.subject,
    outcome: "queued",
    phase: "queued",
    createdAt: input.now,
    updatedAt: input.now,
    branch: input.branch,
  };
}
export function createQueuedRun(input: QueuedRunInput): RunRecord {
  return queuedRun({
    ...input,
    subject: { ...input.issue, kind: "issue" },
    branch: input.branchTemplate
      .replaceAll("{issue}", String(input.issue.number))
      .replaceAll("{attempt}", String(input.attempt))
      .replaceAll("{run}", input.id),
  });
}

export function createQueuedReviewRun(
  input: Omit<QueuedRunInput, "issue" | "branchTemplate"> & {
    request: ReviewRequest;
  },
): RunRecord {
  return {
    ...queuedRun({
      ...input,
      subject: { ...input.request, kind: "change-request" },
      branch: "HEAD",
    }),
    change: input.request.change,
    reviewPublicationId: input.id,
  };
}
