import type {
  EventRecord,
  InvocationRecord,
  ProjectState,
  RunRecord,
} from "@mingchuno/agent-workflows-core";
import {
  currentExecutionId,
  subjectReference,
} from "@mingchuno/agent-workflows-core";
import type { Key } from "ink";
import {
  discoverRuns,
  needsAttention,
  type RunFilter,
  runFilters,
} from "../monitor/discovery.js";
import { terminalText } from "../monitor/text.js";
import type { MonitorAction } from "./data.js";
import type { LogSource } from "./log.js";
import { type RunSection, runSections } from "./sections.js";

type Focus = "runs" | "summary" | "sessions";
type RunAction = "stop" | "retry" | "retry-refresh" | "recover";
type Selection = { projectId?: string; runId?: string };
type Modal =
  | { type: "help" }
  | { type: "configuration" }
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
  section: RunSection;
  expandedTitle: boolean;
  filter: RunFilter;
  query: string;
  searchDraft?: string;
  modal?: Modal;
}
export const initialNavigation: MonitorNavigation = {
  selection: {},
  screen: "dashboard",
  focus: "runs",
  offset: 0,
  section: "Overview",
  expandedTitle: false,
  filter: "All",
  query: "",
};

interface NavigationContext {
  terminalIsLargeEnough: boolean;
  projects: ProjectState[];
  project?: ProjectState;
  runs: RunRecord[];
  projectRuns: RunRecord[];
  run?: RunRecord;
  sessions: InvocationRecord[];
  session?: InvocationRecord;
  events: EventRecord[];
  event?: EventRecord;
  logSessions: InvocationRecord[];
  logSession?: InvocationRecord;
  available: Record<"stop" | "retry" | "recover", boolean>;
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
  if (state.searchDraft !== undefined) {
    if (key.escape) return { state: { ...state, searchDraft: undefined } };
    if (key.return)
      return {
        state: {
          ...state,
          query: state.searchDraft,
          searchDraft: undefined,
          selection: discoverySelection(
            context,
            state.filter,
            state.searchDraft,
          ),
          offset: 0,
        },
      };
    if (key.backspace || key.delete)
      return {
        state: {
          ...state,
          searchDraft: Array.from(state.searchDraft).slice(0, -1).join(""),
        },
      };
    if (
      !key.tab &&
      !key.upArrow &&
      !key.downArrow &&
      !key.leftArrow &&
      !key.rightArrow
    )
      return {
        state: {
          ...state,
          searchDraft:
            state.searchDraft +
            terminalText(input).replaceAll("\n", "").replaceAll("\t", ""),
        },
      };
    return { state };
  }
  if (input === "q") return { state, effect: { type: "exit" } };
  if (!context.terminalIsLargeEnough) return { state };
  if (key.escape)
    return {
      state: { ...state, screen: "dashboard", focus: "runs", offset: 0 },
    };
  if (input === "C")
    return { state: { ...state, modal: { type: "configuration" } } };
  if (input === "?") return { state: { ...state, modal: { type: "help" } } };
  if (input === "R" && !context.pending)
    return { state, effect: { type: "command", kind: "reload", target: "" } };
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
        : input === "F"
          ? "retry-refresh"
          : input === "c"
            ? "recover"
            : undefined;
  if (
    kind &&
    context.run &&
    (kind !== "retry-refresh" || context.run.subject.kind === "issue") &&
    context.available[kind === "retry-refresh" ? "retry" : kind]
  )
    return {
      state: {
        ...state,
        modal: {
          type: "confirmation",
          kind,
          runId: context.run.id,
          title: `${subjectReference(context.run.subject)} ${context.run.subject.title}`,
        },
      },
    };
  if (input === "t")
    return {
      state: {
        ...state,
        screen: "details",
        section: "Overview",
        expandedTitle: !state.expandedTitle,
        offset: 0,
      },
    };
  if (input === "d")
    return {
      state: { ...state, screen: "details", section: "Diagnostics", offset: 0 },
    };
  if (input === "x")
    return {
      state: { ...state, screen: "details", section: "Actions", offset: 0 },
    };
  if (state.screen === "details") {
    if (key.home || key.end)
      return {
        state: { ...state, offset: key.home ? 0 : context.scrollMaximum },
      };
    const section = runSections[Number(input) - 1];
    if (/^[1-7]$/.test(input) && section)
      return { state: { ...state, section, offset: 0 } };
    if (key.tab)
      return {
        state: {
          ...state,
          section:
            runSections[
              (runSections.indexOf(state.section) +
                (key.shift ? runSections.length - 1 : 1)) %
                runSections.length
            ]!,
          offset: 0,
        },
      };
    return { state };
  }
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
    section: "Overview",
    expandedTitle: false,
    sessionId: undefined,
    stepSequence: undefined,
    offset: 0,
    modal:
      state.modal?.type === "confirmation" &&
      state.modal.runId !== selection.runId
        ? undefined
        : state.modal,
  };
}

function dashboardInput(
  state: MonitorNavigation,
  input: string,
  key: Key,
  context: NavigationContext,
): Transition {
  if (input === "/") return { state: { ...state, searchDraft: state.query } };
  if (input === "f")
    return {
      state: {
        ...state,
        filter:
          runFilters[
            (runFilters.indexOf(state.filter) + 1) % runFilters.length
          ]!,
        selection: discoverySelection(
          context,
          runFilters[
            (runFilters.indexOf(state.filter) + 1) % runFilters.length
          ]!,
          state.query,
        ),
        offset: 0,
      },
    };
  if (input === "n") {
    const start = context.projectRuns.findIndex(
      (run) => run.id === context.run?.id,
    );
    const ordered = [
      ...context.projectRuns.slice(start + 1),
      ...context.projectRuns.slice(0, start + 1),
    ];
    const next = ordered.find(needsAttention);
    return {
      state: next
        ? {
            ...state,
            selection: { projectId: context.project?.id, runId: next.id },
            filter: "Attention",
            query: "",
            focus: "runs",
          }
        : state,
    };
  }
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
        selection: {
          projectId: next?.id,
          ...(next?.id === context.project?.id
            ? { runId: context.run?.id }
            : {}),
        },
        filter: next?.id === context.project?.id ? state.filter : "All",
        query: next?.id === context.project?.id ? state.query : "",
        focus: "runs",
        offset: 0,
      },
    };
  }
  if (key.return && context.run)
    return {
      state: { ...state, screen: "details", section: "Overview", offset: 0 },
    };
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
  const executionId = context.run ? currentExecutionId(context.run) : undefined;
  const stageSources = (context.run?.stageLogs ?? [])
    .filter((item) => item.executionId === executionId)
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

function discoverySelection(
  context: NavigationContext,
  filter: RunFilter,
  query: string,
): Selection {
  const matches = discoverRuns(context.projectRuns, filter, query);
  const next = matches.find((run) => run.id === context.run?.id) ?? matches[0];
  return { projectId: context.project?.id, runId: next?.id };
}
