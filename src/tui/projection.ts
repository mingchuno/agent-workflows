import type { RunRecord } from "../domain.js";
import { recoveryUnavailable } from "../recovery.js";
import type { InvocationRecord, ProjectState } from "../store.js";

interface RunProjectionInput {
  run?: RunRecord;
  project?: ProjectState;
  projectRuns: RunRecord[];
  sessions?: InvocationRecord[];
  pending: boolean;
  restriction?: string;
}

/** Operator facts derived from one selected Run; admission remains authoritative. */
export function projectRunProjection({
  run,
  project,
  projectRuns,
  sessions = [],
  pending,
  restriction,
}: RunProjectionInput) {
  const recoveryReason = run
    ? (recoveryUnavailable(run) ??
      project?.blocked ??
      (projectRuns.some(
        (item) => item.taskKey === run.taskKey && item.attempt > run.attempt,
      )
        ? "A newer attempt has superseded this run"
        : undefined))
    : undefined;
  const retryReason =
    restriction ??
    (!run
      ? "Select a run"
      : pending
        ? "Waiting for pending command acknowledgement"
        : !["failed", "blocked", "cancelled"].includes(run.outcome)
          ? "Only failed, blocked or cancelled runs can be retried"
          : projectRuns.some(
                (item) =>
                  item.taskKey === run.taskKey &&
                  ["queued", "running"].includes(item.outcome),
              )
            ? "An active attempt already exists for this task"
            : undefined);
  const stopReason =
    restriction ??
    (!run
      ? "Select a run"
      : pending
        ? "Waiting for pending command acknowledgement"
        : !["queued", "running"].includes(run.outcome)
          ? "Run is already terminal"
          : undefined);
  const recoverReason =
    restriction ??
    (pending
      ? "Waiting for pending command acknowledgement"
      : (recoveryReason ?? (!run ? "Select a run" : undefined)));
  const executionSessions = currentExecutionSessions(run, sessions);
  return {
    recoveryReason,
    actionReasons: {
      stop: stopReason,
      retry: retryReason,
      recover: recoverReason,
    },
    available: {
      stop: !stopReason,
      retry: !retryReason,
      recover: !recoverReason,
    },
    executionSessions,
    detailLogSession: latestSession(executionSessions),
  };
}

function currentExecutionSessions(
  run: RunRecord | undefined,
  sessions: InvocationRecord[],
) {
  const current = run?.executions?.at(-1);
  return current
    ? sessions.filter((item) => item.executionId === current.id)
    : [];
}

function latestSession(sessions: InvocationRecord[]) {
  const byRecency = [...sessions].sort(
    (left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt),
  );
  return (
    byRecency.filter((item) => item.outcome === "running").at(-1) ??
    byRecency.at(-1)
  );
}
