import type { Project } from "../config.js";
import type { HostingAdapter, RunRecord } from "../domain.js";
import type { Store } from "../store.js";
import { syncWorkApprovals } from "./approvals.js";
import { issueSource, sourceIsStale } from "./policy.js";
import type { WorkItem } from "./schema.js";

export type WorkAdmission =
  | { state: "admitted"; run: RunRecord }
  | { state: "waiting"; reason: string };

/**
 * Observe the Work Item's hosted source, import provider approvals, and admit
 * the observed revision once policy reports it ready. A closed issue, a source
 * needing reassessment, or a missing gate leaves the item waiting. Pass
 * `revision` to admit only the revision an operator inspected; replaying an
 * admitted revision returns its latest attempt. Hosting is resolved only for
 * hosted sources, so local work needs no host credentials.
 */
export async function admitWork(
  id: string,
  project: Project,
  dependencies: { store: Store; hosting: () => HostingAdapter },
  options: {
    revision?: string;
    recovery?: { checkSafety: (related: RunRecord[]) => Promise<void> };
  } = {},
): Promise<WorkAdmission> {
  const { store, hosting } = dependencies;
  const { work } = await store.workItems.inspect(id, project);
  const hosted = work.source.kind !== "local";
  const providerApprovals = project.sdlc.approvalSource !== "local-operator";
  let observed = work;
  // Provider approvals are read from the host first; otherwise the host is
  // read only once the item is otherwise ready.
  if (hosted && providerApprovals) {
    const host = hosting();
    const current = await observe(work, project, store, host);
    if (current.state === "waiting") return current;
    await syncWorkApprovals(id, project, store, host);
    observed = current.work;
  }
  const { decision } = await store.workItems.inspect(id, project);
  if (decision.state !== "ready")
    return {
      state: "waiting",
      reason: decision.reasons.map((reason) => reason.message).join("; "),
    };
  if (hosted && !providerApprovals) {
    const current = await observe(work, project, store, hosting());
    if (current.state === "waiting") return current;
    observed = current.work;
  }
  return {
    state: "admitted",
    run: await store.workItems.submit(
      id,
      options.revision ?? observed.revision,
      project,
      options.recovery,
    ),
  };
}

/** Refresh a hosted source; a closed issue or stale contract waits. */
async function observe(
  work: WorkItem,
  project: Project,
  store: Store,
  hosting: HostingAdapter,
): Promise<
  | { state: "observed"; work: WorkItem }
  | Extract<WorkAdmission, { state: "waiting" }>
> {
  if (work.source.kind === "local") return { state: "observed", work };
  const issue = await hosting.getIssue(work.source.number);
  if (!issue.open) return { state: "waiting", reason: "Issue is closed" };
  const refreshed = await store.workItems.refreshSource(
    work.id,
    issueSource(project.hosting.provider, issue),
  );
  if (sourceIsStale(refreshed))
    return {
      state: "waiting",
      reason: "Source changed; reassess before submitting",
    };
  return { state: "observed", work: refreshed };
}
