import type { Project } from "../config.js";
import {
  BlockedError,
  type HostingAdapter,
  type RunRecord,
} from "../domain.js";
import type { Store } from "../store.js";
import {
  contentRevision,
  issueRevision,
  matchesPath,
  reassessChanges,
  workRevision,
} from "./policy.js";

export async function assertWorkAuthorized(
  run: RunRecord,
  project: Project,
  store: Store,
  hosting: HostingAdapter,
): Promise<void> {
  if (run.subject.kind === "change-request") return;
  if (!run.work) {
    if (project.sdlc.enabled)
      throw new BlockedError("SDLC execution requires an authorized Work Item");
    return;
  }
  if (!project.sdlc.enabled)
    throw new BlockedError("SDLC policy was disabled after admission");
  const { work, decision } = await store.workItems.inspect(
    run.work.workItemId,
    project,
  );
  // The revision digests contract and source, so a pinned copy that still
  // hashes to the current revision is the contract and source now stored.
  if (
    work.revision !== run.work.revision ||
    workRevision(run.work.contract, run.work.source) !== work.revision
  )
    throw new BlockedError("Work contract or source changed after admission");
  if (work.source.kind === "local") {
    if (!project.sdlc.allowLocalTasks)
      throw new BlockedError("Local work is disabled by policy");
  } else {
    if (work.source.kind !== project.hosting.provider)
      throw new BlockedError("Work source differs from configured host");
    const issue = await hosting.getIssue(work.source.number);
    if (
      !issue.open ||
      issue.id !== work.source.issueId ||
      issue.url !== work.source.url ||
      issueRevision(issue) !== work.source.revision
    )
      throw new BlockedError(
        "Hosted issue changed after assessment; reassess and reapprove",
      );
  }
  if (decision.state !== "ready")
    throw new BlockedError(
      decision.reasons.map((reason) => reason.message).join("; "),
    );
  const reasons = reassessChanges(
    work.contract,
    run.work.track,
    project.sdlc,
    run.work.changedPaths ?? run.snapshot?.paths ?? [],
  );
  if (reasons.length)
    throw new BlockedError(reasons.map((reason) => reason.message).join("; "));
  if (run.readiness?.draft === false) {
    const checks = workValidation(run, project);
    const results = run.validation ?? [];
    if (
      !checks.length ||
      run.validationStatus !== "passed" ||
      checks.length !== results.length ||
      checks.some(
        (check, index) =>
          check.command !== results[index]?.command ||
          contentRevision(check.args) !==
            contentRevision(results[index]?.args) ||
          results[index]?.exitCode !== 0,
      )
    )
      throw new BlockedError(
        "Current required validation differs from completed checks",
      );
  }
}

export function workValidation(
  run: RunRecord,
  project: Project,
): Project["validation"] {
  if (!run.work) throw new Error("Work validation requires a Work Item");
  const profiles = new Set<string>();
  if (run.work.contract.verification.profile)
    profiles.add(run.work.contract.verification.profile);
  const paths = run.work.changedPaths ?? run.snapshot?.paths ?? [];
  for (const rule of project.sdlc.riskRules) {
    if (
      rule.validationProfile &&
      paths.some((path) => matchesPath(path, rule.paths))
    )
      profiles.add(rule.validationProfile);
  }
  const commands = [...project.validation];
  for (const name of profiles) {
    const checks = project.validationProfiles[name];
    if (!checks)
      throw new BlockedError(`Unknown SDLC validation profile: ${name}`);
    commands.push(...checks);
  }
  return commands;
}
