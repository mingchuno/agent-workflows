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
export function createQueuedRun(input: QueuedRunInput): RunRecord {
  return queuedRun({
    ...input,
    subject:
      "number" in input.issue ? { ...input.issue, kind: "issue" } : input.issue,
    branch: input.branchTemplate
      .replaceAll(
        "{issue}",
        "number" in input.issue ? String(input.issue.number) : input.issue.id,
      )
      .replaceAll("{attempt}", String(input.attempt))
      .replaceAll("{run}", input.id),
  });
}

export function createQueuedWorkRun(
  work: WorkItem,
  project: Project,
  attempt = 1,
): RunRecord {
  const subject: RunSubject =
    work.source.kind === "local"
      ? {
          kind: "local",
          id: work.id,
          title: work.contract.title,
          body: work.contract.intent,
        }
      : {
          kind: "issue",
          id: work.source.issueId,
          number: work.source.number,
          title: work.contract.title,
          body: work.contract.intent,
          url: work.source.url,
          labels: project.workflows.implementation.labels,
          open: true,
        };
  const id = crypto.randomUUID();
  const run = queuedRun({
    id,
    projectId: project.id,
    checkout: project.checkout,
    taskKey: `work:${work.id}`,
    attempt,
    subject,
    now: new Date().toISOString(),
    branch: project.branchTemplate
      .replaceAll(
        "{issue}",
        subject.kind === "local" ? work.id : String(subject.number),
      )
      .replaceAll("{attempt}", String(attempt))
      .replaceAll("{run}", id),
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
