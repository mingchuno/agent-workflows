import type { RunRecord } from "./domain.js";

type QueuedRunInput = Pick<
  RunRecord,
  "id" | "projectId" | "checkout" | "taskKey" | "attempt" | "issue" | "retryOf"
> & { now: string; branchTemplate: string };

export function createQueuedRun(input: QueuedRunInput): RunRecord {
  return {
    id: input.id,
    projectId: input.projectId,
    checkout: input.checkout,
    taskKey: input.taskKey,
    attempt: input.attempt,
    ...(input.retryOf === undefined ? {} : { retryOf: input.retryOf }),
    issue: input.issue,
    outcome: "queued",
    phase: "queued",
    createdAt: input.now,
    updatedAt: input.now,
    branch: input.branchTemplate
      .replaceAll("{issue}", String(input.issue.number))
      .replaceAll("{attempt}", String(input.attempt))
      .replaceAll("{run}", input.id),
  };
}
