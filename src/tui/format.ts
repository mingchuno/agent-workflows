import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import type { ExecutionRecord, RunRecord } from "../domain.js";
import { terminalText } from "./text.js";

const millisecondsPerSecond = 1_000;
const secondsPerMinute = 60;
const secondsPerHour = 60 * secondsPerMinute;
const secondsPerDay = 24 * secondsPerHour;

export function duration(
  start?: string,
  end?: string,
  now = Date.now(),
): string {
  if (!start || !Number.isFinite(Date.parse(start))) return "—";
  const finish = end ? Date.parse(end) : now;
  if (!Number.isFinite(finish)) return "—";
  const seconds = Math.max(
    0,
    Math.floor((finish - Date.parse(start)) / millisecondsPerSecond),
  );
  const days = Math.floor(seconds / secondsPerDay);
  const hours = Math.floor((seconds % secondsPerDay) / secondsPerHour);
  const minutes = Math.floor((seconds % secondsPerHour) / secondsPerMinute);
  return `${days ? `${days}d ` : ""}${hours ? `${hours}h ` : ""}${minutes}m ${seconds % secondsPerMinute}s`;
}
export function executionDuration(
  execution: ExecutionRecord | undefined,
  now: number,
) {
  if (
    !execution ||
    (!execution.finishedAt &&
      !["queued", "running"].includes(execution.outcome))
  )
    return "—";
  return duration(execution.startedAt, execution.finishedAt, now);
}
export function elapsedRun(run: RunRecord, now: number) {
  const latest = run.executions?.at(-1);
  if (!["queued", "running"].includes(run.outcome) && !latest?.finishedAt)
    return "—";
  return duration(run.createdAt, latest?.finishedAt, now);
}
export function colorFor(outcome: string): string | undefined {
  if (process.env.NO_COLOR || process.env.TERM === "dumb") return undefined;
  if (["failed", "cancelled"].includes(outcome)) return "red";
  if (["blocked", "queued"].includes(outcome)) return "yellow";
  if (["completed", "no-change"].includes(outcome)) return "green";
  return "cyan";
}
export function cells(text: string, width: number, offset = 0): string {
  let result = "";
  let position = 0;
  for (const { segment } of new Intl.Segmenter().segment(
    terminalText(text).replaceAll("\n", " ").replaceAll("\t", "    "),
  )) {
    const size = stringWidth(segment);
    if (position >= offset && position + size <= offset + width)
      result += segment;
    position += size;
    if (position >= offset + width) break;
  }
  return result;
}
export function wrapLines(lines: string[], width: number): string[] {
  return lines.flatMap((line) =>
    wrapAnsi(terminalText(line).replaceAll("\t", "    "), Math.max(1, width), {
      hard: true,
      trim: false,
    }).split("\n"),
  );
}
