import { Box, Text } from "ink";
import stringWidth from "string-width";
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

type AvailableActions = {
  stop: boolean;
  retry: boolean;
  recover: boolean;
};

// The detail panel contributes four columns of border and padding.
const detailWideBreakpoint = 136;
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

function conciseError(run: RunRecord): string {
  const error = run.error ?? run.executions?.at(-1)?.error;
  if (!error)
    return run.outcome === "cancelled"
      ? "Run was cancelled."
      : run.outcome === "blocked"
        ? "Run is blocked."
        : "Run requires operator attention.";
  return error.split("\n", 1)[0]!.replace(/^Error:\s*/i, "");
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

function validationLines(run: RunRecord, now: number): string[] {
  return [
    "VALIDATION",
    ...(run.validation?.length
      ? run.validation.flatMap((check) => [
          `${check.command} ${check.args.join(" ")} · exit ${check.exitCode} · ${duration(check.startedAt, check.finishedAt, now)}`,
        ])
      : ["not recorded"]),
  ];
}

function sessionLines(sessions: InvocationRecord[], now: number): string[] {
  return [
    "AGENT SESSIONS",
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
            : `Requested ${readableProfile(session.requested, session.provider)} → Effective ${effective}`;
          return [
            `${session.step} · invocation ${session.attempt} · ${session.outcome} · ${duration(session.startedAt, session.finishedAt, now)}`,
            profile,
          ];
        })
      : ["not recorded"]),
  ];
}

function executionLines(run: RunRecord, now: number): string[] {
  const executions = [...(run.executions ?? [])].reverse();
  if (!executions.length) return ["CURRENT EXECUTION", "not started"];
  return executions.flatMap((execution, index) => [
    index === 0
      ? "CURRENT EXECUTION"
      : `PRIOR EXECUTION ${executions.length - index}`,
    label("Outcome", execution.outcome),
    label("Phase", execution.phase),
    label(
      "Execution duration",
      execution.startedAt
        ? executionDuration(execution, now).replace("—", "unavailable")
        : "not started",
    ),
    label(
      "Queue wait",
      duration(
        execution.createdAt,
        execution.startedAt ?? execution.finishedAt,
        now,
      ),
    ),
    label("Created", localTimestamp(execution.createdAt)),
    label("Started", localTimestamp(execution.startedAt)),
    label("Finished", localTimestamp(execution.finishedAt)),
    ...(execution.recoveryOf
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
      : []),
    ...(index < executions.length - 1 ? [""] : []),
  ]);
}

function padToWidth(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - stringWidth(value)))}`;
}

function columns(left: string[], right: string[], width: number): string[] {
  const gap = " │ ";
  const leftWidth = Math.floor((width - gap.length) * 0.58);
  const rightWidth = width - leftWidth - gap.length;
  const leftLines = wrapDetailLines(left, leftWidth);
  const rightLines = wrapDetailLines(right, rightWidth);
  return Array.from(
    { length: Math.max(leftLines.length, rightLines.length) },
    (_, index) =>
      `${padToWidth(leftLines[index] ?? "", leftWidth)}${gap}${rightLines[index] ?? ""}`,
  );
}

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
  width = 76,
  available: AvailableActions = {
    stop: false,
    retry: false,
    recover: false,
  },
): string[] {
  const validation = run.validation?.length
    ? `${run.validation.length} recorded`
    : "not recorded";
  const recovery =
    run.outcome === "failed"
      ? recoveryReason
        ? "restricted"
        : "eligible"
      : "not applicable";
  const attention = ["failed", "blocked", "cancelled"].includes(run.outcome)
    ? [
        "",
        "ATTENTION",
        label("Problem", conciseError(run)),
        label(
          "Recovery",
          recoveryReason ?? "Eligible; runner checks still apply",
        ),
        label(
          "Action",
          [
            available.recover ? "c recover" : "",
            available.retry ? "r retry" : "",
            available.stop ? "s stop" : "",
          ]
            .filter(Boolean)
            .join(" · ") || "none available",
        ),
      ]
    : [];
  const executions = executionLines(run, now);
  const evidence = [
    ...validationLines(run, now),
    "",
    ...sessionLines(sessions, now),
  ];
  const evidenceArea =
    width >= detailWideBreakpoint
      ? columns(executions, evidence, width)
      : [
          ...executions,
          "",
          ...validationLines(run, now),
          "",
          ...sessionLines(sessions, now),
        ];
  const executionsByRecency = [...(run.executions ?? [])].reverse();
  const executionErrors = executionsByRecency.filter(
    (execution) => execution.error,
  );
  const diagnostics =
    run.error || executionErrors.length
      ? [
          "",
          "DIAGNOSTICS",
          ...(run.error ? [label("Run error", run.error)] : []),
          ...executionErrors.map((execution, index) =>
            label(
              index === 0 ? "Current error" : "Prior error",
              execution.error!,
            ),
          ),
        ]
      : [];
  const technical = [
    "",
    "TECHNICAL DETAILS",
    label("Run ID", run.id),
    label("Issue URL", run.issue.url || "unavailable"),
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
  return [
    `#${run.issue.number} ${run.issue.title}`,
    label("Outcome", run.outcome),
    label("Phase", run.phase),
    label("Attempt", String(run.attempt)),
    label("Total elapsed", elapsedRun(run, now).replace("—", "unavailable")),
    label("Branch", run.branch || "unavailable"),
    label(
      "Health",
      `Error ${run.error || run.executions?.some((execution) => execution.error) ? "recorded" : "none"} · Validation ${validation} · Recovery ${recovery}`,
    ),
    ...attention,
    "",
    ...evidenceArea,
    ...diagnostics,
    ...technical,
  ];
}
export function Lines({
  lines,
  width,
  height,
  offset = 0,
  outcome,
}: {
  lines: string[];
  width: number;
  height: number;
  offset?: number;
  outcome?: string;
}) {
  const wrapped = wrapDetailLines(lines, width);
  const start = Math.min(offset, Math.max(0, wrapped.length - height));
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      {wrapped.slice(start, start + height).map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stateless text rows are identified by their document line.
        <Box key={`${start + index}`} height={1} flexShrink={0}>
          <Text
            wrap="truncate"
            bold={/^[A-Z][A-Z ]+$/.test(line)}
            color={
              line.startsWith("Outcome") ? colorFor(outcome ?? "") : undefined
            }
          >
            {line || " "}
          </Text>
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
