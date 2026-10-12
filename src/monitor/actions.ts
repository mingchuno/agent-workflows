import type { RunRecord } from "../domain.js";
import { recoveryUnavailable } from "../recovery.js";
import type { ProjectState } from "../store.js";

export interface ActionAvailabilityInput {
  run?: RunRecord;
  project?: ProjectState;
  projectRuns: RunRecord[];
  pending: boolean;
  restriction?: string;
}

export function actionAvailability({
  run,
  project,
  projectRuns,
  pending,
  restriction,
}: ActionAvailabilityInput) {
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
  };
}
