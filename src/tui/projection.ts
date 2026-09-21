import type { RunRecord } from "../domain.js";
import { recoveryUnavailable } from "../recovery.js";
import type { EventRecord, InvocationRecord, ProjectState } from "../store.js";

interface RunProjectionInput {
  run?: RunRecord;
  project?: ProjectState;
  projectRuns: RunRecord[];
  sessions?: InvocationRecord[];
  events?: EventRecord[];
  pending: boolean;
}

/** Operator facts derived from one selected Run; admission remains authoritative. */
export function projectRunProjection({
  run,
  project,
  projectRuns,
  sessions = [],
  events = [],
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
  const executionSessions = currentExecutionSessions(run, sessions, events);
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
  events: EventRecord[],
) {
  const current = run?.executions?.at(-1);
  if (!current || (run?.executions?.length ?? 0) <= 1) return sessions;
  const currentStepIds = new Set(
    events.flatMap((event) => {
      const payload = event.payload as {
        executionId?: unknown;
        stepId?: unknown;
      };
      return payload.executionId === current.id &&
        typeof payload.stepId === "number"
        ? [payload.stepId]
        : [];
    }),
  );
  if (currentStepIds.size)
    return sessions.filter((item) => currentStepIds.has(item.stepId));
  const executionCreatedAt = Date.parse(current.createdAt);
  if (!Number.isFinite(executionCreatedAt)) return [];
  return sessions.filter(
    (item) => Date.parse(item.startedAt) >= executionCreatedAt,
  );
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
