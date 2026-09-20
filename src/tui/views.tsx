import { Box, Text } from "ink";
import type { RunRecord } from "../domain.js";
import { recoveryUnavailable } from "../recovery.js";
import type { EventRecord, InvocationRecord } from "../store.js";
import {
  cells,
  colorFor,
  duration,
  elapsedRun,
  executionDuration,
  wrapLines,
} from "./format.js";

function stepText(event?: EventRecord): string {
  if (!event) return "No steps recorded";
  const payload = event.payload as {
    name?: string;
    status?: string;
    attempt?: number;
    executionId?: string;
  };
  return `${payload.name ?? "step"} · ${payload.status ?? "recorded"} · attempt ${payload.attempt ?? "—"}`;
}
export function summaryLines(
  run: RunRecord,
  now: number,
  event?: EventRecord,
): string[] {
  return [
    `#${run.issue.number} ${run.issue.title}`,
    `${run.outcome.toUpperCase()} · ${run.phase}`,
    `Attempt ${run.attempt} · Execution ${executionDuration(run.executions?.at(-1), now)}`,
    "",
    "PROGRESS",
    stepText(event),
    "",
    "VALIDATION",
    ...(run.validation?.map(
      (check) => `${check.command}: exit ${check.exitCode}`,
    ) ?? ["No checks recorded"]),
    "",
    "NEXT ACTION",
    ...(run.error
      ? [
          `Error: ${run.error.split("\n")[0]}`,
          "Enter details for the full error and recovery evidence",
        ]
      : [
          run.outcome === "running"
            ? "Workflow is running"
            : run.outcome === "queued"
              ? "Waiting for runner and project intake"
              : ["failed", "blocked", "cancelled"].includes(run.outcome)
                ? "Inspect details before retry or recovery"
                : "Workflow finished; inspect the outcome",
        ]),
    ...(run.change ? [`Change request: ${run.change.url}`] : []),
  ];
}
export function detailLines(
  run: RunRecord,
  sessions: InvocationRecord[],
  now: number,
  recoveryReason = recoveryUnavailable(run),
): string[] {
  return [
    `#${run.issue.number} ${run.issue.title}`,
    `${run.outcome} · ${run.phase} · attempt ${run.attempt}`,
    `Run: ${run.id}`,
    `Branch: ${run.branch}`,
    `Issue: ${run.issue.url}`,
    `Total elapsed: ${elapsedRun(run, now)}`,
    ...(run.executions ?? []).flatMap((execution, index) => [
      "",
      `EXECUTION ${index + 1}: ${execution.id}`,
      `${execution.outcome} · ${execution.phase} · duration ${executionDuration(execution, now)}`,
      `Queue wait: ${duration(execution.createdAt, execution.startedAt ?? execution.finishedAt, now)}`,
      `Started: ${execution.startedAt ?? "Not started"} · Finished: ${execution.finishedAt ?? "—"}`,
      ...(execution.recoveryOf
        ? [
            `Recovered from: ${execution.recoveryOf}`,
            `Reused: ${execution.reusedSteps?.join(", ") ?? "—"}`,
          ]
        : []),
    ]),
    "",
    "RECOVERY",
    recoveryReason ?? "Eligible for admission; runner checks still required",
    "",
    "ERROR",
    run.error ?? "None",
    "",
    "VALIDATION",
    ...(run.validation?.flatMap((check) => [
      `${check.command} ${check.args.join(" ")} · exit ${check.exitCode} · ${duration(check.startedAt, check.finishedAt, now)}`,
      `Log: ${check.log}`,
    ]) ?? ["No checks recorded"]),
    "",
    "AGENT SESSIONS",
    ...sessions.flatMap((session) => [
      `${session.step} · invocation ${session.attempt} · ${session.outcome}`,
      `Session: ${session.sessionId ?? session.sessionState}`,
      `Duration: ${duration(session.startedAt, session.finishedAt, now)}`,
      `Requested: ${JSON.stringify(session.requested)}`,
      `Effective: ${JSON.stringify(session.effective)}`,
      `Log: ${session.log}`,
      "",
    ]),
  ];
}
export function Lines({
  lines,
  width,
  height,
  offset = 0,
}: {
  lines: string[];
  width: number;
  height: number;
  offset?: number;
}) {
  const wrapped = wrapLines(lines, width);
  const start = Math.min(offset, Math.max(0, wrapped.length - height));
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      {wrapped.slice(start, start + height).map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stateless text rows are identified by their document line.
        <Box key={`${start + index}`} height={1} flexShrink={0}>
          <Text wrap="truncate">{line || " "}</Text>
        </Box>
      ))}
    </Box>
  );
}
export function RunList({
  runs,
  selected,
  width,
  height,
  now,
}: {
  runs: RunRecord[];
  selected?: string;
  width: number;
  height: number;
  now: number;
}) {
  const count = Math.max(1, Math.floor(height / 3));
  const current = Math.max(
    0,
    runs.findIndex((run) => run.id === selected),
  );
  const start = Math.max(
    0,
    Math.min(current - Math.floor(count / 2), runs.length - count),
  );
  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      {runs.length ? (
        runs.slice(start, start + count).map((run) => (
          <Box key={run.id} flexDirection="column" height={3}>
            <Text
              inverse={run.id === selected}
              bold={run.id === selected}
              wrap="truncate"
            >
              {cells(
                `${run.id === selected ? ">" : " "} #${run.issue.number} ${run.issue.title}`,
                width,
              )}
            </Text>
            <Text color={colorFor(run.outcome)} wrap="truncate">
              {cells(
                `  ${run.outcome} · ${run.phase} · ${executionDuration(run.executions?.at(-1), now)}`,
                width,
              )}
            </Text>
            <Text dimColor>{cells(`  attempt ${run.attempt}`, width)}</Text>
          </Box>
        ))
      ) : (
        <Text>No runs yet. Waiting for eligible issues.</Text>
      )}
    </Box>
  );
}
