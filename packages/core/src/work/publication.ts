import type { Project } from "../config.js";
import { BlockedError, type HostingAdapter, type Issue } from "../domain.js";
import type { Store } from "../store.js";
import { WorkConflictError } from "./errors.js";
import {
  approvalComment,
  issueRevision,
  issueSource,
  resolveTrack,
} from "./policy.js";
import type {
  ApprovalGate,
  SdlcPolicy,
  WorkContract,
  WorkItem,
} from "./schema.js";
import type { WorkInspection } from "./store.js";

const opening = (id: string) => `<!-- agent-workflows:contract:${id} -->`;
const closing = (id: string) => `<!-- /agent-workflows:contract:${id} -->`;

// Authored text must not open an HTML comment that could forge a marker.
function inline(value: string): string {
  return value.replaceAll("<!--", "&lt;!--");
}
function list(items: string[], format = inline): string[] {
  return items.map((item) => `- ${format(item)}`);
}
function section(title: string, lines: string[]): string[] {
  return lines.length ? [`### ${title}`, "", ...lines, ""] : [];
}
function code(value: string): string {
  return `\`${value.replaceAll("`", "")}\``;
}

function approvalLines(contract: WorkContract, policy: SdlcPolicy): string[] {
  if (policy.approvalSource === "local-operator")
    return [
      "Approve in the agent-workflows monitor (`agent-workflows monitor`).",
    ];
  const gates: ApprovalGate[] =
    resolveTrack(contract, policy).track === "A" ? [] : ["scope"];
  if (contract.design) gates.push("design");
  return gates.length
    ? [
        `An allowed approver (${policy.approvers.map(code).join(", ")}) approves by commenting exactly:`,
        "",
        ...gates.map(
          (gate) => `- ${gate}: ${code(approvalComment(contract, gate))}`,
        ),
        "",
        "A comment counts only after this section was last published.",
      ]
    : [];
}

/** The managed issue section presenting a Work Item's contract. */
export function renderContract(
  id: string,
  contract: WorkContract,
  policy: SdlcPolicy,
): string {
  const { assessment, verification, design } = contract;
  const lines = [
    opening(id),
    "## Work contract",
    "",
    `Published by agent-workflows from Work Item ${code(id)}. Change the Work Item, not this section; an issue edit requires reassessment.`,
    "",
    `**Track ${resolveTrack(contract, policy).track}**`,
    "",
    ...section("Context", contract.context ? [inline(contract.context)] : []),
    ...section("Intent", [inline(contract.intent)]),
    ...section("Acceptance criteria", list(contract.acceptanceCriteria)),
    ...section("Constraints", list(contract.constraints)),
    ...section("Assumptions", list(contract.assumptions)),
    ...section("Scope", list(contract.scopePaths, code)),
    ...section("Assessment", [
      `- Complexity: ${assessment.complexity}`,
      `- Risk flags: ${assessment.riskFlags.join(", ") || "none"}`,
      ...list(assessment.uncertainties.map((item) => `Open question: ${item}`)),
      ...list(assessment.reasons),
    ]),
    ...section("Verification", [
      ...(verification.profile
        ? [`- Profile: ${code(verification.profile)}`]
        : []),
      ...(verification.strategy ? [`- ${inline(verification.strategy)}`] : []),
      ...list(verification.manualChecks.map((item) => `Manual: ${item}`)),
    ]),
    ...(design
      ? section("Design", [
          inline(design.summary),
          "",
          ...design.stages.map(
            (stage, index) => `${index + 1}. ${inline(stage)}`,
          ),
          "",
          `- Verification: ${inline(design.verification)}`,
          `- Rollback: ${inline(design.rollback)}`,
          ...list(design.alternatives.map((item) => `Alternative: ${item}`)),
          ...list(design.references),
        ])
      : []),
    ...section("References", list(contract.references)),
    ...section("Approval", approvalLines(contract, policy)),
    closing(id),
  ];
  return lines.join("\n");
}

/** Replace the Work Item's managed section in `body`, or append it. */
export function withContractSection(
  body: string,
  id: string,
  rendered: string,
): string {
  const start = body.indexOf(opening(id));
  const end = body.indexOf(closing(id), start);
  if (start >= 0 && end >= 0)
    return (
      body.slice(0, start) + rendered + body.slice(end + closing(id).length)
    );
  return body.trim() ? `${body.trimEnd()}\n\n${rendered}` : rendered;
}

/**
 * Publish the current contract to the project's issue tracker after explicit
 * human confirmation. Local work gets a new issue and is rebound to it; an
 * issue-backed item gets its managed body section replaced. The managed
 * section's marker makes a repeated publication find the issue it created.
 * An issue changed since observation, including by an interrupted update,
 * requires reassessment first.
 */
export async function publishWork(
  id: string,
  project: Project,
  dependencies: { store: Store; hosting: HostingAdapter },
  options: { revision: string },
): Promise<WorkInspection> {
  const { store, hosting } = dependencies;
  const { createIssue, updateIssueBody, findIssues } = hosting;
  if (!createIssue || !updateIssueBody || !findIssues)
    throw new Error("Hosting adapter cannot publish issues");
  const write = async (issue: Issue, rendered: string, work: WorkItem) => {
    const body = withContractSection(issue.body, work.id, rendered);
    return body === issue.body
      ? issue
      : updateIssueBody.call(hosting, issue.number, body);
  };
  await store.workItems.publish(id, options.revision, project, async (work) => {
    const rendered = renderContract(work.id, work.contract, project.sdlc);
    const provider = project.hosting.provider;
    if (work.source.kind === "local") {
      const found = await findIssues.call(hosting, {
        text: opening(work.id),
        since: work.createdAt,
      });
      if (found.length > 1)
        throw new BlockedError(
          "Several issues carry this Work Item's contract",
        );
      const issue =
        found[0] ??
        (await createIssue.call(hosting, {
          title: work.contract.title,
          body: rendered,
        }));
      if (!issue.open) throw new BlockedError("Published issue is closed");
      return issueSource(provider, await write(issue, rendered, work));
    }
    const issue = await hosting.getIssue(work.source.number);
    if (!issue.open) throw new BlockedError("Issue is closed");
    // An interrupted update is indistinguishable from a human edit, so both
    // require reassessment of the observed issue.
    if (issueRevision(issue) !== work.source.revision)
      throw new WorkConflictError("Source changed; reassess before publishing");
    return issueSource(provider, await write(issue, rendered, work));
  });
  return store.workItems.inspect(id, project);
}
