import stringWidth from "string-width";
import type { RunRecord } from "../domain.js";
import { subjectReference } from "../domain.js";
import { needsAttention } from "../monitor/discovery.js";
import { cells, chromeText, executionDuration, wrapLines } from "./format.js";
import type { projectRunProjection } from "./projection.js";

export type RunProjection = ReturnType<typeof projectRunProjection>;
const phaseLabels: Record<string, string> = {
  implementation: "Implementation",
  review: "Reviewing changes",
  validation: "Validation",
  publication: "Preparing publication",
  commit: "Commit",
  push: "Push",
  "change-request": "Create change request",
  "review-publication": "Publish review",
  eligibility: "Eligibility",
  preparation: "Preparation",
};
export function phaseLabel(phase: string): string {
  return phaseLabels[phase] ?? phase;
}
export function subjectKind(run: RunRecord): string {
  return run.subject.kind === "issue" ? "ISSUE" : "REVIEW";
}
export function runIdentity(run: RunRecord): string {
  return `${run.projectId} / ${subjectReference(run.subject)} ${subjectKind(run)} ${run.subject.title}`;
}
export function runState(run: RunRecord, now: number): string {
  return [
    run.outcome.toUpperCase(),
    ...(run.outcome === "completed" && run.readiness?.draft
      ? ["Draft delivered"]
      : []),
    phaseLabel(run.phase),
    executionDuration(run.executions?.at(-1), now),
    `attempt ${run.attempt}`,
  ].join(chromeText(" · "));
}
export function ellipsis(text: string, width: number): string {
  const full = cells(text, Number.MAX_SAFE_INTEGER);
  if (stringWidth(full) <= width) return full;
  const marker =
    process.env.TERM === "dumb" || process.env.AW_TUI_ASCII === "1"
      ? "..."
      : "…";
  if (width < marker.length) return cells(marker, width);
  return `${cells(full, Math.max(0, width - marker.length))}${marker}`;
}
export interface FailurePresentation {
  problem: string;
  evidence: string;
  next: string;
}
/** Only recorded facts establish a diagnosis; free-form provider messages remain clues. */
export function failurePresentation(
  run: RunRecord,
  projection: RunProjection,
): FailurePresentation | undefined {
  if (!needsAttention(run)) return undefined;
  const error = run.error ?? run.executions?.at(-1)?.error;
  const evidence =
    error?.replace(/^Error:\s*/i, "") || "No diagnostic recorded.";
  const failedCheck = run.validation?.find((check) => check.exitCode !== 0);
  let problem = `${phaseLabel(run.phase)} ${run.outcome === "blocked" ? "is blocked" : "failed"}.`;
  let next = "Inspect the full diagnostic and relevant logs before retrying.";
  if (run.outcome === "cancelled") {
    problem = "Run was cancelled.";
    next = "Inspect the checkout before starting a fresh attempt.";
  } else if (failedCheck && run.phase === "validation") {
    problem = `Check ${failedCheck.command} ${failedCheck.args.join(" ")} exited ${failedCheck.exitCode}.`;
    next = "Open validation logs (v), fix the failing check, then retry.";
  } else if (run.outcome === "blocked") {
    next =
      "Inspect the blocking diagnostic and checkout; resolve the restriction before retrying.";
  } else if (
    /(not accessible|permission|unauthorized|forbidden|403|401)/i.test(evidence)
  ) {
    next =
      "Possible cause: credential access. Check repository access and required write permissions.";
  }
  if (projection.available.recover)
    next += " Then continue publication with c recover.";
  return { problem, evidence, next };
}
function boundedField(
  name: string,
  text: string,
  width: number,
  maximumLines = 2,
): string[] {
  const prefix = `${name.padEnd(9)}`;
  const valueWidth = Math.max(1, Math.min(width, 112) - prefix.length);
  const wrapped = wrapLines([text], valueWidth);
  const limited = wrapped.slice(0, maximumLines);
  if (wrapped.length > maximumLines)
    limited[maximumLines - 1] = ellipsis(
      `${limited.at(-1)} ${wrapped[maximumLines]}`,
      valueWidth,
    );
  return limited.map(
    (line, index) => `${index ? " ".repeat(prefix.length) : prefix}${line}`,
  );
}
export function overviewLines(
  run: RunRecord,
  projection: RunProjection,
  width: number,
): string[] {
  const failure = failurePresentation(run, projection);
  const actions = [
    projection.available.recover ? "c recover" : "",
    projection.available.retry ? "r retry" : "",
    projection.available.stop ? "s stop" : "",
  ]
    .filter(Boolean)
    .join(chromeText(" · "));
  if (failure)
    return [
      ...boundedField("Problem", failure.problem, width),
      ...boundedField("Evidence", failure.evidence.split("\n")[0]!, width),
      "",
      ...boundedField("Next", failure.next, width),
      "",
      ...boundedField(
        "Action",
        actions || "Unavailable; x shows reasons",
        width,
        1,
      ),
      ...(!projection.available.recover
        ? boundedField(
            "Recovery",
            projection.actionReasons.recover ?? "Unavailable",
            width,
          )
        : [
            "Recovery reuses completed publication work; runner checks still apply.",
          ]),
      ...(projection.available.retry
        ? ["Retry creates a new run and branch."]
        : []),
      ...(run.head
        ? [
            `Recorded commit: ${run.head.slice(0, 12)} (6 Technical for full evidence)`,
          ]
        : []),
      chromeText("d full diagnostic · x actions · t full subject"),
    ];
  return [
    run.outcome === "running"
      ? "Workflow is running; this monitor can close while work continues."
      : run.outcome === "queued"
        ? "Waiting for runner and project intake."
        : run.outcome === "superseded"
          ? "Review target changed; this run does not establish coverage of the new target."
          : run.outcome === "completed" && run.readiness?.draft
            ? "Draft delivered. Inspect Checks for unresolved findings and limitations."
            : "Workflow finished. Inspect Checks for delivery and validation evidence.",
    ...(run.readiness?.reasons ?? []),
    ...(run.change ? [`Change request: ${run.change.url}`] : []),
    "",
    ...boundedField("Branch", run.branch || "Not recorded", width),
    ...boundedField("Updated", run.updatedAt, width),
    "",
    chromeText("2 Activity · 3 Checks · 4 Executions · 6 Technical"),
  ];
}
export function actionLines(
  run: RunRecord,
  projection: RunProjection,
): string[] {
  return [
    "Actions and eligibility",
    "",
    `c recover: ${projection.available.recover ? "Available (runner checks still apply)" : projection.actionReasons.recover}`,
    "Continue the failed publication step in this run, reusing completed checkpoints.",
    "",
    `r retry: ${projection.available.retry ? "Available" : projection.actionReasons.retry}`,
    "Create a new run and branch; execute the workflow again.",
    ...(run.subject.kind === "issue"
      ? ["F retry with current hosted issue and validation selection."]
      : []),
    "",
    `s stop: ${projection.available.stop ? "Available" : projection.actionReasons.stop}`,
    "Cancel this run and wait for its active local work to stop.",
    "",
    "Confirmation defaults to Cancel. Commands remain pending until acknowledged.",
    "Closing the monitor never stops workflows.",
  ];
}
