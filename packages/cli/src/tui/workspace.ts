import type {
  EventRecord,
  InvocationRecord,
  RunRecord,
} from "@mingchuno/agent-workflows-core";
import {
  actionLines,
  overviewLines,
  type RunProjection,
} from "./presentation.js";
import type { RunSection } from "./sections.js";
import {
  activityLines,
  deliveryLines,
  diagnosticLines,
  executionLines,
  technicalLines,
  validationLines,
} from "./views.js";

export function workspaceLines({
  run,
  projection,
  sessions,
  events,
  section,
  now,
  width,
}: {
  run: RunRecord;
  projection: RunProjection;
  sessions: InvocationRecord[];
  events: EventRecord[];
  section: RunSection;
  now: number;
  width: number;
}): string[] {
  switch (section) {
    case "Overview":
      return overviewLines(run, projection, width);
    case "Activity":
      return activityLines(sessions, events, now);
    case "Checks":
      return [...deliveryLines(run), ...validationLines(run, now)];
    case "Executions":
      return executionLines(run, now);
    case "Diagnostics":
      return diagnosticLines(run);
    case "Technical":
      return technicalLines(run, sessions);
    case "Actions":
      return actionLines(run, projection);
  }
}
