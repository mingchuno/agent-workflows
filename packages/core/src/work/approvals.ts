import type { Project } from "../config.js";
import type { HostingAdapter } from "../domain.js";
import type { Store } from "../store.js";
import { approvalComment, issueRevision, sourceIsStale } from "./policy.js";
import { renderContract, withContractSection } from "./publication.js";

export async function syncWorkApprovals(
  id: string,
  project: Project,
  store: Store,
  hosting: HostingAdapter,
): Promise<number> {
  const { work } = await store.workItems.inspect(id, project);
  const source = work.source;
  if (
    source.kind === "local" ||
    project.sdlc.approvalSource === "local-operator"
  )
    return 0;
  if (
    source.kind !== project.hosting.provider ||
    source.kind !== project.sdlc.approvalSource
  )
    throw new Error("Approval host differs from Work Item source");
  if (!project.sdlc.approvers.length)
    throw new Error(
      "Provider approvals require an explicit human approver allowlist",
    );
  if (!hosting.listApprovalComments)
    throw new Error(
      "Hosting adapter cannot read authenticated approval evidence",
    );
  const issue = await hosting.getIssue(source.number);
  if (
    !issue.open ||
    issueRevision(issue) !== source.revision ||
    sourceIsStale(work)
  )
    throw new Error("Source changed; reassess before syncing approval");
  const comments = await hosting.listApprovalComments(source.number);
  // A short comment names the contract printed on the issue, so it counts only
  // while the issue shows the current contract and only once posted after the
  // Work Item last changed; older comments may predate a source edit.
  const published =
    withContractSection(
      issue.body,
      id,
      renderContract(id, work.contract, project.sdlc),
    ) === issue.body;
  const changedAt = Date.parse(work.updatedAt);
  let count = 0;
  for (const gate of ["scope", "design"] as const) {
    const { decision } = await store.workItems.inspect(id, project);
    if (decision.awaitingGate !== gate) continue;
    const body = `agent-workflows approve ${id} ${gate} ${work.revision}`;
    const short = approvalComment(work.contract, gate);
    const comment = comments.find(
      (entry) =>
        entry.human &&
        project.sdlc.approvers.includes(entry.author) &&
        (entry.body.trim() === body ||
          (published &&
            entry.body.trim() === short &&
            entry.createdAt !== undefined &&
            Date.parse(entry.createdAt) > changedAt)),
    );
    if (!comment) continue;
    await store.workItems.approve(
      id,
      work.revision,
      gate,
      {
        approvedBy: comment.author,
        source: source.kind,
        evidence: comment.url,
      },
      project,
    );
    count++;
  }
  return count;
}
