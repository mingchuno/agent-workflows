import type { MonitorSnapshot } from "../src/web/contracts.js";

/** Keep a selected run visible even when it falls outside the current filter. */
export function selectMonitorRuns(
  snapshot: MonitorSnapshot | undefined,
  selection: { projectId?: string; runId?: string },
) {
  const project =
    snapshot?.projects.find((project) => project.id === selection.projectId) ??
    snapshot?.projects[0];
  const projectRuns =
    snapshot?.runs.filter((run) => run.projectId === project?.id) ?? [];
  const visibleRunIds = new Set(snapshot?.visibleRunIds);
  const visibleRuns = projectRuns.filter(
    (run) => run.id === selection.runId || visibleRunIds.has(run.id),
  );
  const run =
    visibleRuns.find((run) => run.id === selection.runId) ?? visibleRuns[0];
  return { project, projectRuns, visibleRuns, run };
}
