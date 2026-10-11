import type { RunRecord } from "../domain.js";
import { subjectReference } from "../domain.js";
import { terminalText } from "./text.js";

export const runFilters = [
  "All",
  "Attention",
  "Active",
  "Queued",
  "Finished",
] as const;
export type RunFilter = (typeof runFilters)[number];
export function needsAttention(run: RunRecord): boolean {
  return ["failed", "blocked", "cancelled"].includes(run.outcome);
}
export function matchesFilter(run: RunRecord, filter: RunFilter): boolean {
  switch (filter) {
    case "Attention":
      return needsAttention(run);
    case "Active":
      return run.outcome === "running";
    case "Queued":
      return run.outcome === "queued";
    case "Finished":
      return (
        !["running", "queued"].includes(run.outcome) && !needsAttention(run)
      );
    default:
      return true;
  }
}
export function discoverRuns(
  runs: RunRecord[],
  filter: RunFilter,
  query: string,
): RunRecord[] {
  const needle = terminalText(query).toLocaleLowerCase().trim();
  return runs.filter(
    (run) =>
      matchesFilter(run, filter) &&
      terminalText(
        `${run.projectId} ${subjectReference(run.subject)} ${run.subject.title} ${run.id}`,
      )
        .toLocaleLowerCase()
        .includes(needle),
  );
}
export function runCounts(runs: RunRecord[]): string {
  return `${runs.filter(needsAttention).length} need attention · ${runs.filter((run) => run.outcome === "running").length} active · ${runs.filter((run) => run.outcome === "queued").length} queued · ${runs.filter((run) => matchesFilter(run, "Finished")).length} finished`;
}
