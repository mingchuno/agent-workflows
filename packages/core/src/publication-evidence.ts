import {
  maxPublicationDescriptionLength,
  type Publication,
  publicationSchema,
  type RunRecord,
} from "./domain.js";

const evidenceLimit = 20_000;

function bounded(text: string, limit: number, notice: string): string {
  return text.length <= limit
    ? text
    : text.slice(0, limit - notice.length) + notice;
}

/** Reserve space for authoritative delivery evidence, keeping full evidence in the Run. */
export function withDeliveryEvidence(
  publication: Publication,
  run: RunRecord,
): Publication {
  if (!run.readiness) return publication;
  const evidence = bounded(
    [
      "## Workflow delivery",
      run.readiness.draft
        ? "Draft: further work is required."
        : "Ready for human review.",
      ...run.readiness.reasons,
      `Configured checks: ${run.validation?.length ? run.validation.map((check) => `${check.command} ${check.args.join(" ")}: exit ${check.exitCode}`).join("; ") : "not configured (skipped)"}`,
      `Agent-reported checks (not workflow-executed): ${JSON.stringify(run.agentReport?.validation ?? [])}`,
      `Agent-reported limitations: ${JSON.stringify(run.agentReport?.limitations ?? [])}`,
      `Inspection limitations: ${JSON.stringify(run.review?.limitations ?? [])}`,
      `Remaining findings: ${JSON.stringify(run.review?.findings ?? [])}`,
    ].join("\n"),
    evidenceLimit,
    `\nAdditional evidence retained in Run ${run.id}.`,
  );
  const description = bounded(
    publication.description,
    maxPublicationDescriptionLength - evidence.length - 2,
    "\n[Publication prose shortened to retain workflow evidence.]",
  );
  return publicationSchema.parse({
    ...publication,
    description: description + "\n\n" + evidence,
  });
}
