import type { ExecutionRecord, RunRecord } from "../src/domain.js";

export function reference(run: RunRecord) {
  return `${run.subject.kind === "issue" ? "Issue" : "Review"} #${run.subject.number}`;
}
export function timestamp(value?: string) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isFinite(date.valueOf())
    ? date.toLocaleString()
    : "Unavailable";
}
export function executionDuration(execution?: ExecutionRecord) {
  if (!execution?.startedAt) return "Not started";
  if (
    !execution.finishedAt &&
    !["running", "queued"].includes(execution.outcome)
  )
    return "Not recorded";
  return durationBetween(execution.startedAt, execution.finishedAt);
}
export function durationBetween(start?: string, end?: string) {
  if (!start || !Number.isFinite(Date.parse(start))) return "Not recorded";
  const finish = end ? Date.parse(end) : Date.now();
  if (!Number.isFinite(finish)) return "Not recorded";
  const seconds = Math.max(0, Math.floor((finish - Date.parse(start)) / 1000));
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
export function safeLink(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
