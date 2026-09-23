import type { Key } from "ink";
import type { RunRecord } from "../domain.js";
import type { EventRecord, InvocationRecord, ProjectState } from "../store.js";
import type { MonitorAction } from "./data.js";
import type { LogSource } from "./log.js";

type Focus = "runs" | "summary" | "sessions";
type RunAction = "stop" | "retry" | "recover";
type Selection = { projectId?: string; runId?: string };
type Modal =
  | { type: "help" }
  | { type: "confirmation"; kind: RunAction; runId: string; title: string }
  | { type: "logs"; sources: LogSource[]; initial: number };

export interface MonitorNavigation {
  selection: Selection;
  /** Actual displayed run, which may fall back from a requested selection. */
  displayedRunId?: string;
  screen: "dashboard" | "details";
  focus: Focus;
  sessionId?: string;
  stepSequence?: number;
  offset: number;
  modal?: Modal;
}
export const initialNavigation: MonitorNavigation = {
  selection: {},
  screen: "dashboard",
  focus: "runs",
  offset: 0,
};

interface NavigationContext {
  terminalIsLargeEnough: boolean;
  projects: ProjectState[];
  project?: ProjectState;
  runs: RunRecord[];
  run?: RunRecord;
  sessions: InvocationRecord[];
  session?: InvocationRecord;
  events: EventRecord[];
  event?: EventRecord;
  logSessions: InvocationRecord[];
  logSession?: InvocationRecord;
  available: Record<RunAction, boolean>;
  pending: boolean;
  scrollMaximum: number;
  pageSize: number;
}
export type NavigationEvent =
  | { type: "selection"; selection: Selection }
  | { type: "dismiss" }
  | { type: "key"; input: string; key: Key; context: NavigationContext };
interface Transition {
  state: MonitorNavigation;
  effect?:
    | { type: "exit" }
    | { type: "command"; kind: MonitorAction; target: string };
}
const focuses: Focus[] = ["runs", "summary", "sessions"];

/** Pure navigation transitions; the monitor owns rendering and command effects. */
export function transitionNavigation(
  state: MonitorNavigation,
  event: NavigationEvent,
): Transition {
  if (event.type === "dismiss")
    return { state: { ...state, modal: undefined } };
  if (event.type === "selection")
    return { state: synchronizeSelection(state, event.selection) };
  const { input, key, context } = event;
  if (key.ctrl || key.meta || key.eventType === "release") return { state };
  // Dialogs/logs own keyboard input, except when hidden by the resize screen.
  if (state.modal && context.terminalIsLargeEnough) return { state };
  if (input === "q") return { state, effect: { type: "exit" } };
  if (!context.terminalIsLargeEnough) return { state };
  if (key.escape)
    return {
      state: { ...state, screen: "dashboard", focus: "runs", offset: 0 },
    };
  if (input === "?") return { state: { ...state, modal: { type: "help" } } };
  if (key.upArrow || key.downArrow || key.pageUp || key.pageDown)
    return { state: moveVertically(state, key, context) };
  if (input === "l") return { state: openAgentLog(state, context) };
  if (input === "v" && context.run?.validation?.length)
    return {
      state: {
        ...state,
        modal: {
          type: "logs",
          sources: context.run.validation.map((check) => ({
            path: check.log,
            label: `${check.command} · exit ${check.exitCode}`,
          })),
          initial: 0,
        },
      },
    };
  const kind =
    input === "s"
      ? "stop"
      : input === "r"
        ? "retry"
        : input === "c"
          ? "recover"
          : undefined;
  if (kind && context.run && context.available[kind])
    return {
      state: {
        ...state,
        modal: {
          type: "confirmation",
          kind,
          runId: context.run.id,
          title: `#${context.run.issue.number} ${context.run.issue.title}`,
        },
      },
    };
  if (state.screen === "details") return { state };
  return dashboardInput(state, input, key, context);
}

function synchronizeSelection(
  state: MonitorNavigation,
  selection: Selection,
): MonitorNavigation {
  const sameRun = state.displayedRunId === selection.runId;
  if (
    sameRun &&
    state.selection.projectId === selection.projectId &&
    state.selection.runId === selection.runId
  )
    return state;
  if (sameRun) return { ...state, selection };
  return {
    ...state,
    selection,
    displayedRunId: selection.runId,
    sessionId: undefined,
    stepSequence: undefined,
    offset: 0,
    modal: state.modal?.type === "confirmation" ? undefined : state.modal,
  };
}

function dashboardInput(
  state: MonitorNavigation,
  input: string,
  key: Key,
  context: NavigationContext,
): Transition {
  if (key.tab)
    return {
      state: {
        ...state,
        focus:
          focuses[(focuses.indexOf(state.focus) + (key.shift ? 2 : 1)) % 3]!,
        offset: 0,
      },
    };
  if (input === "a") return { state: { ...state, focus: "sessions" } };
  if (key.leftArrow || key.rightArrow) {
    const next = adjacent(
      context.projects,
      context.projects.findIndex((item) => item.id === context.project?.id),
      key.leftArrow ? -1 : 1,
    );
    return {
      state: {
        ...state,
        selection: { projectId: next?.id },
        focus: "runs",
        offset: 0,
      },
    };
  }
  if (key.return && context.run)
    return { state: { ...state, screen: "details", offset: 0 } };
  if (input === "[" || input === "]") {
    const next = adjacent(
      context.events,
      context.events.findIndex(
        (item) => item.sequence === context.event?.sequence,
      ),
      input === "]" ? 1 : -1,
    );
    return { state: { ...state, stepSequence: next?.sequence } };
  }
  if (key.end) return { state: { ...state, stepSequence: undefined } };
  if (input === "p" && context.project && !context.pending)
    return {
      state,
      effect: {
        type: "command",
        kind: context.project.paused ? "resume" : "pause",
        target: context.project.id,
      },
    };
  return { state };
}

function moveVertically(
  state: MonitorNavigation,
  key: Key,
  context: NavigationContext,
): MonitorNavigation {
  const delta = key.upArrow || key.pageUp ? -1 : 1;
  if (state.screen === "details" || state.focus === "summary") {
    const current =
      state.screen === "details"
        ? Math.min(state.offset, context.scrollMaximum)
        : state.offset;
    const distance = key.pageUp || key.pageDown ? context.pageSize : 1;
    return {
      ...state,
      offset: Math.max(
        0,
        Math.min(context.scrollMaximum, current + delta * distance),
      ),
    };
  }
  if (state.focus === "sessions") {
    const next = adjacent(
      context.sessions,
      context.sessions.findIndex((item) => item.id === context.session?.id),
      delta,
    );
    return { ...state, sessionId: next?.id };
  }
  const next = adjacent(
    context.runs,
    context.runs.findIndex((item) => item.id === context.run?.id),
    delta,
  );
  return {
    ...state,
    selection: { projectId: context.project?.id, runId: next?.id },
  };
}

function openAgentLog(
  state: MonitorNavigation,
  context: NavigationContext,
): MonitorNavigation {
  const currentExecutionId =
    context.run?.executions?.at(-1)?.id ?? context.run?.id;
  const stageSources = (context.run?.stageLogs ?? [])
    .filter((item) => item.executionId === currentExecutionId)
    .map((item) => ({
      path: item.path,
      label: `${item.step} · stage diagnostic`,
    }));
  const sources = [
    ...stageSources,
    ...context.logSessions.map((session) => ({
      path: session.log,
      label: `${session.step} · invocation ${session.attempt}`,
    })),
  ];
  if (!sources.length) return state;
  return {
    ...state,
    modal: {
      type: "logs",
      sources,
      initial: context.logSession
        ? Math.max(
            0,
            stageSources.length +
              context.logSessions.findIndex(
                (session) => session.id === context.logSession?.id,
              ),
          )
        : 0,
    },
  };
}

function adjacent<T>(items: T[], index: number, delta: number): T | undefined {
  return items[Math.max(0, Math.min(items.length - 1, index + delta))];
}
