import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useEffect, useState } from "react";
import { currentExecutionId } from "../domain.js";
import { minimumTerminalSize } from "./constants.js";
import { type MonitorSource, useMonitorData } from "./data.js";
import { ConfirmDialog, HelpDialog } from "./dialogs.js";
import { runCounts } from "./discovery.js";
import { chromeCells as cells, chromeText, colorFor } from "./format.js";
import { monitorLayout } from "./layout.js";
import { LogViewer } from "./log.js";
import {
  initialNavigation,
  type NavigationEvent,
  transitionNavigation,
} from "./monitor-navigation.js";
import type { ExecutionNotificationWriter } from "./notifications.js";
import { ellipsis } from "./presentation.js";
import { projectRunProjection } from "./projection.js";
import { Shortcuts } from "./shortcuts.js";
import { Lines, RunList, wrapDetailLines } from "./views.js";
import { workspaceLines } from "./workspace.js";
import { RunWorkspace } from "./workspace-view.js";

const notificationNoticeDurationMs = 2000;

const statusRefreshIntervalMs = 1_000;
const actionDescriptions = {
  stop: "Cancel this run and wait for its active local work to stop.",
  retry: "Create a new run and branch; execute the workflow again.",
  "retry-refresh":
    "Create a new run using the current hosted issue and validation selection.",
  recover: "Continue the failed publication step using completed work.",
};

export function Monitor({
  source,
  size,
  notificationWriter,
}: {
  source: MonitorSource;
  size?: { columns: number; rows: number };
  notificationWriter?: ExecutionNotificationWriter;
}) {
  const window = useWindowSize();
  const { columns, rows } = size ?? window;
  const { exit } = useApp();
  const [navigation, setNavigation] = useState(initialNavigation);
  const { selection, focus, screen, sessionId, stepSequence, offset, modal } =
    navigation;
  const confirmation = modal?.type === "confirmation" ? modal : undefined;
  const logs = modal?.type === "logs" ? modal : undefined;
  const data = useMonitorData(
    source,
    selection,
    notificationWriter,
    navigation,
  );
  const { projects, project, projectRuns, run, sessions, events } = data;
  const dismissModal = () =>
    setNavigation(
      (current) => transitionNavigation(current, { type: "dismiss" }).state,
    );
  const [now, setNow] = useState(Date.now());
  const [notificationNoticeUntil] = useState(
    () => Date.now() + notificationNoticeDurationMs,
  );
  const showNotificationNotice =
    Boolean(notificationWriter) && now < notificationNoticeUntil;
  const dashboard = screen === "dashboard";
  const layout = monitorLayout(
    columns,
    rows -
      (showNotificationNotice ? 1 : 0) -
      (navigation.searchDraft !== undefined ? 1 : 0),
  );
  const { wide, height, paneWidth, summaryWidth } = layout;
  const session = sessions.find((item) => item.id === sessionId) ?? sessions[0];
  const projection = projectRunProjection({
    run,
    project,
    projectRuns,
    sessions,
    pending: Boolean(data.pending),
    restriction:
      data.snapshotStatus !== "connected"
        ? "Snapshot is unavailable or stale; wait for a successful refresh"
        : undefined,
  });
  const { executionSessions, detailLogSession, available } = projection;
  const event =
    events.find((item) => item.sequence === stepSequence) ?? events.at(-1);
  useEffect(() => {
    const timer = setInterval(
      () => setNow(Date.now()),
      statusRefreshIntervalMs,
    );
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    // Pin default selections and reset run-specific navigation in one transition.
    setNavigation(
      (current) =>
        transitionNavigation(current, {
          type: "selection",
          selection: { projectId: project?.id, runId: run?.id },
        }).state,
    );
  }, [project?.id, run?.id]);
  const viewport = screen === "details" ? layout.details : layout.summary;
  const section = screen === "details" ? navigation.section : "Overview";
  const document = run
    ? workspaceLines({
        run,
        projection,
        sessions,
        events,
        section,
        now,
        width: viewport.width,
      })
    : ["Run no longer available"];
  if (
    screen === "dashboard" &&
    run &&
    !["failed", "blocked", "cancelled"].includes(run.outcome)
  ) {
    const payload = event?.payload as
      | { name?: string; status?: string }
      | undefined;
    document.splice(
      1,
      0,
      ...(payload
        ? [
            `Latest step: ${payload.name ?? "step"} ${chromeText("·")} ${payload.status ?? "recorded"}`,
          ]
        : []),
      ...sessions
        .slice(0, 2)
        .map(
          (item) =>
            `${item.id === session?.id ? ">" : " "} ${item.step} ${chromeText("·")} invocation ${item.attempt} ${chromeText("·")} ${item.outcome}`,
        ),
    );
  }
  if (run && navigation.expandedTitle && section === "Overview")
    document.unshift("Full subject", run.subject.title, "");
  const wrappedDocument = wrapDetailLines(document, viewport.width);
  const displayedOffset = Math.min(
    offset,
    Math.max(0, wrappedDocument.length - viewport.height),
  );
  const terminalIsLargeEnough =
    columns >= minimumTerminalSize.columns && rows >= minimumTerminalSize.rows;
  useInput((input, key) => {
    const scrollLines = wrappedDocument;
    const navigationEvent: NavigationEvent = {
      type: "key",
      input,
      key,
      context: {
        terminalIsLargeEnough,
        projects,
        project,
        runs: data.visibleRuns,
        projectRuns,
        run,
        sessions,
        session,
        events,
        event,
        logSessions: screen === "details" ? executionSessions : sessions,
        logSession: screen === "details" ? detailLogSession : session,
        available,
        pending: Boolean(data.pending),
        scrollMaximum: Math.max(0, scrollLines.length - viewport.height),
        pageSize: viewport.height,
      },
    };
    const { effect } = transitionNavigation(navigation, navigationEvent);
    setNavigation(
      (current) => transitionNavigation(current, navigationEvent).state,
    );
    if (effect?.type === "exit") exit();
    if (effect?.type === "command")
      void data.action(effect.kind, effect.target);
  });
  if (!terminalIsLargeEnough)
    return (
      <Box width={columns} height={rows} flexDirection="column">
        <Text>
          {cells(
            `Resize terminal to at least ${minimumTerminalSize.columns}×${minimumTerminalSize.rows}. q closes monitor.`,
            columns,
          )}
        </Text>
      </Box>
    );
  if (modal?.type === "help")
    return <HelpDialog columns={columns} rows={rows} onClose={dismissModal} />;
  if (confirmation)
    return (
      <ConfirmDialog
        columns={columns}
        rows={rows}
        title={`Confirm ${confirmation.kind}`}
        subject={confirmation.title}
        description={actionDescriptions[confirmation.kind]}
        available={
          run?.id === confirmation.runId &&
          available[
            confirmation.kind === "retry-refresh" ? "retry" : confirmation.kind
          ]
        }
        onCancel={dismissModal}
        onConfirm={() => {
          void data.action(confirmation.kind, confirmation.runId);
          dismissModal();
        }}
      />
    );
  if (logs)
    return (
      <LogViewer
        {...logs}
        columns={columns}
        rows={rows}
        onBack={dismissModal}
      />
    );
  const freshness = data.lastUpdated
    ? `refreshed ${Math.max(0, Math.floor((now - data.lastUpdated) / statusRefreshIntervalMs))}s ago`
    : "freshness unavailable";
  const status = `${columns < 120 ? data.connection.replace(/^Database /, "DB ") : data.connection} · ${freshness}`;
  const selectedSessionLines = sessions.length
    ? sessions.map(
        (item) =>
          `${item.id === session?.id ? ">" : " "} ${item.step} ${chromeText("·")} invocation ${item.attempt} ${chromeText("·")} ${item.outcome}`,
      )
    : ["No agent sessions recorded"];
  const detailsLogControl = detailLogSession
    ? columns < 120
      ? "l current log"
      : `l log: ${detailLogSession.step} invocation ${detailLogSession.attempt} (${detailLogSession.outcome})`
    : run?.stageLogs?.some(
          (item) => item.executionId === currentExecutionId(run),
        )
      ? "l stage diagnostic"
      : "";
  const controls = [
    available.recover
      ? "c recover"
      : available.retry
        ? "r retry"
        : available.stop
          ? "s stop"
          : "",
    run &&
    (dashboard ? detailsLogControl || sessions.length : detailsLogControl)
      ? columns < 120
        ? "l log"
        : detailsLogControl || "l log"
      : "",
    run?.validation?.length ? "v checks" : "",
    "x actions",
    "R reload",
    "? help",
    "q close",
  ]
    .filter(Boolean)
    .join(" · ");
  const emptyMessage =
    data.snapshotStatus === "loading"
      ? "Loading workflow snapshot..."
      : data.snapshotStatus === "unavailable"
        ? "Snapshot unavailable. Check database access; this monitor retries automatically."
        : projectRuns.length
          ? "No matching runs. Press / to edit search or f to change filter."
          : "No runs yet. Waiting for eligible issues.";
  const showList = dashboard && (wide || focus === "runs");
  const showWorkspace = !dashboard || wide || focus !== "runs";
  const workspaceWidth = dashboard && wide ? summaryWidth : columns;
  const showSessions = dashboard && focus === "sessions";
  return (
    <Box width={columns} height={rows} flexDirection="column">
      <Text bold wrap="truncate">
        {cells(
          `Agent Workflows${project ? ` / ${project.id}` : ""} / ${dashboard ? "Monitor" : "Run details"}`,
          columns,
        )}
      </Text>
      <Text wrap="truncate">
        {cells(
          data.stateNotice ??
            (project
              ? `Intake ${project.paused ? "paused" : "enabled"} · Left/Right project (${projects.findIndex((item) => item.id === project.id) + 1}/${projects.length})${project.blocked ? ` · Project BLOCKED: ${project.blocked}` : ""}`
              : data.snapshotStatus === "connected"
                ? "No projects registered. Start the runner to populate this view."
                : "Waiting for project snapshot"),
          columns,
        )}
      </Text>
      <Text
        wrap="truncate"
        color={
          projectRuns.some((item) =>
            ["failed", "blocked", "cancelled"].includes(item.outcome),
          )
            ? colorFor("blocked")
            : undefined
        }
      >
        {cells(
          `${data.snapshotStatus === "loading" || data.snapshotStatus === "unavailable" ? "Run counts unavailable" : runCounts(projectRuns)}${data.snapshotStatus === "stale" ? " · Stale snapshot" : ""}`,
          columns,
        )}
      </Text>
      {navigation.searchDraft !== undefined && (
        <Text wrap="truncate">
          {cells(
            `Search runs: ${navigation.searchDraft}_ · Enter apply · Esc cancel`,
            columns,
          )}
        </Text>
      )}
      <Box height={height} flexDirection="row" overflow="hidden">
        {showList && (
          <Box width={paneWidth} height={height} flexDirection="column">
            <Text bold wrap="truncate">
              {ellipsis(
                `Runs / ${navigation.filter} (${data.visibleRuns.length})${navigation.query ? ` / ${navigation.query}` : ""}`,
                paneWidth,
              )}
            </Text>
            <RunList
              runs={data.visibleRuns}
              selected={run?.id}
              width={layout.runs.width}
              height={layout.runs.height}
              now={now}
              emptyMessage={emptyMessage}
            />
          </Box>
        )}
        {dashboard && wide && (
          <Box width={3} height={height}>
            <Text dimColor>{" | "}</Text>
          </Box>
        )}
        {showWorkspace &&
          (run ? (
            <RunWorkspace
              run={run}
              section={section}
              now={now}
              dashboard={dashboard}
              detailError={data.detailError}
              content={{
                lines: document,
                width: workspaceWidth,
                height: viewport.height,
                offset: displayedOffset,
              }}
              sessions={
                showSessions
                  ? {
                      lines: selectedSessionLines,
                      offset: Math.max(
                        0,
                        sessions.findIndex((item) => item.id === session?.id) -
                          2,
                      ),
                    }
                  : undefined
              }
            />
          ) : (
            <Lines
              lines={[emptyMessage]}
              width={workspaceWidth}
              height={height}
            />
          ))}
      </Box>
      {showNotificationNotice && (
        <Text wrap="truncate">
          {cells(
            "Notifications enabled; delivery is best-effort and depends on terminal settings",
            columns,
          )}
        </Text>
      )}
      <Text
        wrap="truncate"
        color={
          data.snapshotStatus === "stale" ||
          data.snapshotStatus === "unavailable"
            ? colorFor("failed")
            : undefined
        }
      >
        {cells(
          data.message ||
            `${data.snapshotStatus === "stale" ? "Stale snapshot · " : ""}${status} · runner liveness unverified`,
          columns,
        )}
      </Text>
      <Shortcuts
        text={
          dashboard
            ? "Up/Down select · Enter inspect · f filter · n attention · / search · Tab pane"
            : "Up/Down scroll · PgUp/PgDn page · Tab section · d diagnostic · Esc back · t subject"
        }
        width={columns}
      />
      <Shortcuts text={controls} width={columns} />
    </Box>
  );
}
