import type { Project } from "./config.js";
import type {
  Issue,
  LocalSubject,
  ReviewRequest,
  RunRecord,
  RunSubject,
} from "./domain.js";
import { resolveTrack } from "./work/policy.js";
import type { WorkItem } from "./work/schema.js";

type QueuedRunInput = Pick<
  RunRecord,
  "id" | "projectId" | "checkout" | "taskKey" | "attempt" | "retryOf"
> & { issue: Issue | LocalSubject; now: string; branchTemplate: string };

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
function branchName(
  template: string,
  subject: Issue | LocalSubject,
  attempt: number,
  id: string,
): string {
  return template
    .replaceAll(
      "{issue}",
      "number" in subject ? String(subject.number) : subject.id,
    )
    .replaceAll("{attempt}", String(attempt))
    .replaceAll("{run}", id);
}
export function createQueuedRun(input: QueuedRunInput): RunRecord {
  return queuedRun({
    ...input,
    subject:
      "number" in input.issue ? { ...input.issue, kind: "issue" } : input.issue,
    branch: branchName(
      input.branchTemplate,
      input.issue,
      input.attempt,
      input.id,
    ),
  });
}

/** A new attempt of `previous`, carrying its review identity and pinned Work contract. */
export function createRetryRun(
  previous: RunRecord,
  input: Omit<QueuedRunInput, "projectId" | "taskKey" | "retryOf" | "issue"> & {
    issue?: Issue;
  },
): RunRecord {
  const base = {
    ...input,
    projectId: previous.projectId,
    taskKey: previous.taskKey,
    retryOf: previous.id,
  };
  if (previous.subject.kind === "change-request")
    return {
      ...createQueuedReviewRun({ ...base, request: previous.subject }),
      reviewPublicationId: previous.reviewPublicationId,
      review: previous.review,
      reviewHead: previous.reviewHead,
    };
  const retry = createQueuedRun({
    ...base,
    issue: input.issue ?? previous.subject,
  });
  // Changed paths belong to the previous attempt's checkout snapshot.
  if (previous.work) retry.work = { ...previous.work, changedPaths: undefined };
  return retry;
}

export function createQueuedWorkRun(
  work: WorkItem,
  project: Project,
  attempt = 1,
): RunRecord {
  const subject: Issue | LocalSubject =
    work.source.kind === "local"
      ? {
          kind: "local",
          id: work.id,
          title: work.contract.title,
          body: work.contract.intent,
        }
      : {
          id: work.source.issueId,
          number: work.source.number,
          title: work.contract.title,
          body: work.contract.intent,
          url: work.source.url,
          labels: project.workflows.implementation.labels,
          open: true,
        };
  const run = createQueuedRun({
    id: crypto.randomUUID(),
    projectId: project.id,
    checkout: project.checkout,
    taskKey: `work:${work.id}`,
    attempt,
    issue: subject,
    now: new Date().toISOString(),
    branchTemplate: project.branchTemplate,
  });
  run.work = {
    workItemId: work.id,
    revision: work.revision,
    contract: work.contract,
    source: work.source,
    track: resolveTrack(work.contract, project.sdlc).track,
  };
  return run;
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
