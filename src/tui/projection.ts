import type { RunRecord } from "../domain.js";
import { recoveryUnavailable } from "../recovery.js";
import type { InvocationRecord, ProjectState } from "../store.js";

interface RunProjectionInput {
  run?: RunRecord;
  project?: ProjectState;
  projectRuns: RunRecord[];
  sessions?: InvocationRecord[];
  pending: boolean;
}

/** Operator facts derived from one selected Run; admission remains authoritative. */
export function projectRunProjection({
  run,
  project,
  projectRuns,
  sessions = [],
  pending,
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
  const executionSessions = currentExecutionSessions(run, sessions);
  return {
    recoveryReason,
    available: {
      stop: Boolean(
        run && !pending && ["queued", "running"].includes(run.outcome),
      ),
      retry: Boolean(
        run &&
          !pending &&
          ["failed", "blocked", "cancelled"].includes(run.outcome) &&
          !projectRuns.some(
            (item) =>
              item.taskKey === run.taskKey &&
              ["queued", "running"].includes(item.outcome),
          ),
      ),
      recover: Boolean(run && !pending && !recoveryReason),
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
