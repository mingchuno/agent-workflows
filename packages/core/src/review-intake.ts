import type { Project } from "./config.js";
import type { ReviewRequest, RunRecord } from "./domain.js";

export function reviewEligible(
  request: ReviewRequest,
  project: Project,
): boolean {
  return (
    project.workflows.review.enabled &&
    request.open &&
    !request.draft &&
    !request.fork &&
    project.workflows.review.labels.every((label) =>
      request.labels.includes(label),
    )
  );
}
export function sameReviewRevision(
  left: ReviewRequest,
  right: ReviewRequest,
): boolean {
  return (
    left.id === right.id &&
    left.number === right.number &&
    left.url === right.url &&
    left.change.head === right.change.head &&
    left.base === right.base &&
    left.start === right.start &&
    left.targetBranch === right.targetBranch &&
    left.sourceBranch === right.sourceBranch
  );
}
export function reviewTaskKey(
  identity: string,
  project: Project,
  request: ReviewRequest,
): string {
  const suffix = project.workflows.review.rereviewOnPush
    ? `:${request.change.head}`
    : "";
  return `${identity}:${project.id}:review:${request.id}${suffix}`;
}
export function alreadyReviewed(
  runs: RunRecord[],
  project: Project,
  request: ReviewRequest,
): boolean {
  return runs.some(
    (run) =>
      run.projectId === project.id &&
      run.change?.id === request.change.id &&
      run.change.url === request.change.url &&
      run.outcome === "completed" &&
      run.review?.complete === true &&
      (!project.workflows.review.rereviewOnPush ||
        run.reviewHead === request.change.head),
  );
}
