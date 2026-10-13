import type {
  InvocationRecord,
  ProjectState,
  RunRecord,
} from "@mingchuno/agent-workflows-core";
import { actionAvailability } from "@mingchuno/agent-workflows-core/operator";

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
  const executionSessions = currentExecutionSessions(run, sessions);
  return {
    ...actionAvailability({ run, project, projectRuns, pending, restriction }),
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
