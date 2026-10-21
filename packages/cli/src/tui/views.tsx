import type {
  EventRecord,
  InvocationRecord,
  RunRecord,
} from "@mingchuno/agent-workflows-core";
import { subjectReference } from "@mingchuno/agent-workflows-core";
import { Box, Text } from "ink";
import { needsAttention } from "../monitor/discovery.js";
import {
  chromeText,
  colorFor,
  duration,
  executionDuration,
  wrapLines,
} from "./format.js";
import { ellipsis, phaseLabel, subjectKind } from "./presentation.js";

const detailLabelWidth = 19;
const hangingLabelMarker = "\u{e000}";

function localTimestamp(value?: string): string {
  if (!value) return "not recorded";
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return "unavailable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}

function profileValue(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate ? candidate : undefined;
}

function readableProfile(value: unknown, fallbackProvider?: string): string {
  return [
    profileValue(value, "provider") ??
      fallbackProvider ??
      "provider unavailable",
    profileValue(value, "model") ?? "model unavailable",
    profileValue(value, "reasoningEffort") ?? "reasoning unavailable",
  ].join(" / ");
}

function sameProfile(
  requested: unknown,
  effective: unknown,
  provider: string,
): boolean {
  return (
    readableProfile(requested, provider) ===
    readableProfile(effective, provider)
  );
}

function json(value: unknown): string {
  return JSON.stringify(value) ?? "unavailable";
}

function label(label: string, value: string): string {
  return `${hangingLabelMarker}${label.padEnd(detailLabelWidth)}${value}`;
}

export function wrapDetailLines(lines: string[], width: number): string[] {
  return lines.flatMap((line) => {
    if (!line.startsWith(hangingLabelMarker)) return wrapLines([line], width);
    const content = line.slice(hangingLabelMarker.length);
    const prefix = content.slice(0, detailLabelWidth);
    const value = content.slice(detailLabelWidth);
    const wrappedValue = wrapLines(
      [value],
      Math.max(1, width - detailLabelWidth),
    );
    return wrappedValue.map((part, index) =>
      index === 0
        ? `${prefix}${part}`
        : `${" ".repeat(detailLabelWidth)}${part}`,
    );
  });
}

export function deliveryLines(run: RunRecord): string[] {
  if (!run.readiness) return [];
  return [
    "Delivery",
    label("Readiness", run.readiness.draft ? "draft" : "ready for review"),
    ...run.readiness.reasons,
    label("Review rounds", String(run.reviewRounds?.length ?? 0)),
    run.review?.summary ?? "Review not recorded",
    ...(run.review?.findings.map(
      (finding) =>
        `[${finding.priority ?? "P2"}] ${finding.path ?? "summary"}${finding.line ? `:${finding.line}` : ""}: ${finding.body}`,
    ) ?? []),
    ...(run.review?.limitations.map(
      (limitation) => `Review limitation: ${limitation}`,
    ) ?? []),
    "Agent-reported validation (not workflow-executed)",
    ...(run.agentReport?.validation.map(
      (check) =>
        `${check.command} ${chromeText("·")} ${check.outcome} ${chromeText("·")} ${check.details}`,
    ) ?? []),
    ...(run.agentReport?.limitations.map(
      (limitation) => `Agent limitation: ${limitation}`,
    ) ?? []),
    "",
  ];
}

export function validationLines(run: RunRecord, now: number): string[] {
  return [
    "Workflow validation",
    ...(run.validation?.length
      ? run.validation.flatMap((check) => [
          `${check.command} ${check.args.join(" ")} ${chromeText("·")} exit ${check.exitCode} ${chromeText("·")} ${duration(check.startedAt, check.finishedAt, now)}`,
        ])
      : [
          run.validationStatus === "skipped"
            ? "not configured (skipped)"
            : "not recorded",
        ]),
  ];
}

export function sessionLines(
  sessions: InvocationRecord[],
  now: number,
): string[] {
  return [
    "Agent sessions",
    ...(sessions.length
      ? sessions.flatMap((session) => {
          const effective = readableProfile(
            session.effective,
            session.provider,
          );
          const profile = sameProfile(
            session.requested,
            session.effective,
            session.provider,
          )
            ? `Effective ${effective}`
            : `Requested ${readableProfile(session.requested, session.provider)} ${chromeText("→")} Effective ${effective}`;
          return [
            `${session.step} ${chromeText("·")} invocation ${session.attempt} ${chromeText("·")} ${session.outcome} ${chromeText("·")} ${duration(session.startedAt, session.finishedAt, now)}`,
            profile,
          ];
        })
      : ["not recorded"]),
  ];
}

export function executionLines(run: RunRecord, now: number): string[] {
  const executions = [...(run.executions ?? [])].reverse();
  if (!executions.length) return ["Current execution", "not started"];
  return executions.flatMap((execution, index) => {
    const executionTime = execution.startedAt
      ? executionDuration(execution, now).replace("—", "unavailable")
      : "not started";
    const queueWait = duration(
      execution.createdAt,
      execution.startedAt ?? execution.finishedAt,
      now,
    );
    const recovery = execution.recoveryOf
      ? [
          label("Recovery", "continued from prior execution"),
          label(
            "Recovery gap",
            duration(
              run.executions?.find(
                (candidate) => candidate.id === execution.recoveryOf,
              )?.finishedAt,
              execution.createdAt,
              now,
            ).replace("—", "unavailable"),
          ),
          label(
            "Reused steps",
            execution.reusedSteps?.length
              ? execution.reusedSteps.join(", ")
              : "none recorded",
          ),
        ]
      : [];
    const lines =
      index === 0
        ? [
            "Current execution",
            label("Outcome", execution.outcome),
            label("Phase", execution.phase),
            label("Execution duration", executionTime),
            label("Queue wait", queueWait),
            label("Created", localTimestamp(execution.createdAt)),
            label("Started", localTimestamp(execution.startedAt)),
            label("Finished", localTimestamp(execution.finishedAt)),
            ...recovery,
          ]
        : [
            `Prior execution ${executions.length - index}`,
            `${execution.outcome} ${chromeText("·")} ${execution.phase} ${chromeText("·")} duration ${executionTime} ${chromeText("·")} queue ${queueWait}`,
            `${localTimestamp(execution.startedAt)} → ${localTimestamp(execution.finishedAt)}`,
            ...recovery,
          ];
    return index < executions.length - 1 ? [...lines, ""] : lines;
  });
}

export function technicalLines(
  run: RunRecord,
  sessions: InvocationRecord[],
): string[] {
  const executionsByRecency = [...(run.executions ?? [])].reverse();
  return [
    "",
    "Technical details",
    label("Subject", run.subject.title),
    label("Run ID", run.id),
    label(
      run.subject.kind === "issue" ? "Issue URL" : "Change URL",
      ("url" in run.subject ? run.subject.url : "Local task") || "unavailable",
    ),
    label("Checkout", run.checkout || "unavailable"),
    label("Task key", run.taskKey),
    label("Created ISO", run.createdAt),
    label("Updated ISO", run.updatedAt),
    ...(run.retryOf ? [label("Retry of", run.retryOf)] : []),
    ...(run.base ? [label("Base revision", run.base)] : []),
    ...(run.head ? [label("Head revision", run.head)] : []),
    ...(run.change ? [label("Change URL", run.change.url)] : []),
    ...executionsByRecency.flatMap((execution, index) => [
      "",
      `Execution ${executionsByRecency.length - index}`,
      label("Execution ID", execution.id),
      label("Created ISO", execution.createdAt),
      label("Started ISO", execution.startedAt ?? "not recorded"),
      label("Finished ISO", execution.finishedAt ?? "not recorded"),
      ...(execution.recoveryOf
        ? [label("Recovery source", execution.recoveryOf)]
        : []),
    ]),
    ...(run.validation?.flatMap((check, index) => [
      "",
      `Validation ${index + 1}`,
      label("Log path", check.log),
      label("Started ISO", check.startedAt),
      label("Finished ISO", check.finishedAt),
    ]) ?? []),
    ...sessions.flatMap((session, index) => [
      "",
      `Agent session ${index + 1}`,
      label("Invocation ID", session.id),
      label("Session ID", session.sessionId ?? session.sessionState),
      label("Provider", session.provider),
      label("Log path", session.log),
      label("Started ISO", session.startedAt),
      label("Finished ISO", session.finishedAt ?? "not recorded"),
      label("Requested profile", json(session.requested)),
      label("Effective profile", json(session.effective)),
    ]),
  ];
}

export function diagnosticLines(run: RunRecord): string[] {
  return [
    "Full diagnostic",
    ...(run.error ? ["Run error", run.error] : []),
    ...[...(run.executions ?? [])]
      .reverse()
      .flatMap((execution, index) =>
        execution.error
          ? [
              "",
              index === 0
                ? "Current execution error"
                : `Prior execution error (${execution.id})`,
              execution.error,
            ]
          : [],
      ),
    ...(!run.error && !run.executions?.some((execution) => execution.error)
      ? [
          "No diagnostic recorded. Open relevant stage or validation logs when available.",
        ]
      : []),
  ];
}
export function activityLines(
  sessions: InvocationRecord[],
  events: EventRecord[],
  now: number,
): string[] {
  return [
    "Recorded activity",
    ...events
      .slice(-20)
      .reverse()
      .map((event) => {
        const payload = event.payload as { name?: string; status?: string };
        return `${event.createdAt || "Time not recorded"} ${chromeText("·")} ${payload.name ?? "step"} ${chromeText("·")} ${payload.status ?? "recorded"}`;
      }),
    ...(!events.length ? ["No steps recorded"] : []),
    "",
    ...sessionLines(sessions, now),
  ];
}
export function Lines({
  lines,
  width,
  height,
  offset = 0,
  renderLine,
}: {
  lines: string[];
  width: number;
  height: number;
  offset?: number;
  renderLine?: (line: string) => React.ReactNode;
}) {
  const wrapped = wrapDetailLines(lines, width);
  const start = Math.min(offset, Math.max(0, wrapped.length - height));
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      {wrapped.slice(start, start + height).map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stateless terminal rows are identified by their absolute document line.
        <Text key={`${start + index}`} wrap="truncate">
          {renderLine ? renderLine(line) : line || " "}
        </Text>
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
  emptyMessage = "No runs yet. Waiting for eligible issues.",
}: {
  runs: RunRecord[];
  selected?: string;
  width: number;
  height: number;
  now: number;
  emptyMessage?: string;
}) {
  const count = Math.max(1, Math.floor(height / 2));
  const current = Math.max(
    0,
    runs.findIndex((run) => run.id === selected),
  );
  const start = Math.max(
    0,
    Math.min(current - Math.floor(count / 2), runs.length - count),
  );
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      {runs.length ? (
        runs.slice(start, start + count).map((run) => {
          const repeated = runs.some(
            (other) => other.id !== run.id && other.taskKey === run.taskKey,
          );
          const reference = `${subjectReference(run.subject)} ${subjectKind(run)}`;
          return (
            <Box key={run.id} flexDirection="column" height={2} flexShrink={0}>
              <Text
                inverse={run.id === selected}
                bold={run.id === selected}
                wrap="truncate"
              >
                {ellipsis(
                  `${run.id === selected ? ">" : " "} ${needsAttention(run) ? "! " : ""}${reference} ${run.subject.title}`,
                  width,
                )}
              </Text>
              <Text color={colorFor(run.outcome)} wrap="truncate">
                {ellipsis(
                  `  ${run.outcome} ${chromeText("·")} ${run.outcome === "completed" && run.readiness?.draft ? "Draft delivered" : phaseLabel(run.phase)} ${chromeText("·")} a${run.attempt} ${chromeText("·")} ${executionDuration(run.executions?.at(-1), now)}${repeated ? ` ${chromeText("·")} #${run.attempt} ${run.id.slice(-8)}` : ""}`,
                  width,
                )}
              </Text>
            </Box>
          );
        })
      ) : (
        <Lines lines={[emptyMessage]} width={width} height={height} />
      )}
    </Box>
  );
}
