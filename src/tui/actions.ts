import type { RunRecord } from "../domain.js";
import { recoveryUnavailable } from "../recovery.js";
import type { ProjectState } from "../store.js";

/** Display eligibility only; the runner still validates command admission. */
export function actionAvailability({
  run,
  project,
  projectRuns,
  pending,
}: {
  run?: RunRecord;
  project?: ProjectState;
  projectRuns: RunRecord[];
  pending: boolean;
}) {
  const recoveryReason = run
    ? (recoveryUnavailable(run) ??
      project?.blocked ??
      (projectRuns.some(
        (item) => item.taskKey === run.taskKey && item.attempt > run.attempt,
      )
        ? "A newer attempt has superseded this run"
        : undefined))
    : undefined;
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
  };
}
