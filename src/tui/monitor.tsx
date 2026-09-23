import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useEffect, useState } from "react";
import { minimumTerminalSize } from "./constants.js";
import { type MonitorSource, useMonitorData } from "./data.js";
import { ConfirmDialog, HelpDialog } from "./dialogs.js";
import { cells, colorFor, wrapLines } from "./format.js";
import { monitorLayout } from "./layout.js";
import { LogViewer } from "./log.js";
import {
  initialNavigation,
  type NavigationEvent,
  transitionNavigation,
} from "./monitor-navigation.js";
import type { ExecutionNotificationWriter } from "./notifications.js";
import { projectRunProjection } from "./projection.js";
import {
  detailLines,
  Lines,
  RunList,
  summaryLines,
  wrapDetailLines,
} from "./views.js";

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
  const data = useMonitorData(source, selection, notificationWriter);
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
  const layout = monitorLayout(
    columns,
    rows - (showNotificationNotice ? 1 : 0),
    screen === "details",
  );
  const { wide, height, paneWidth, summaryWidth } = layout;
  const session = sessions.find((item) => item.id === sessionId) ?? sessions[0];
  const { executionSessions, detailLogSession, recoveryReason, available } =
    projectRunProjection({
      run,
      project,
      projectRuns,
      sessions,
      events,
      pending: Boolean(data.pending),
    });
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
  const detailDocument = run
    ? detailLines(
        run,
        sessions,
        now,
        recoveryReason,
        layout.details.width,
        available,
      )
    : ["Run no longer available"];
  const wrappedDetailLines = wrapDetailLines(
    detailDocument,
    layout.details.width,
  );
  const detailOffset = Math.min(
    offset,
    Math.max(0, wrappedDetailLines.length - layout.details.height),
  );
  const terminalIsLargeEnough =
    columns >= minimumTerminalSize.columns && rows >= minimumTerminalSize.rows;
  useInput((input, key) => {
    const viewport = screen === "details" ? layout.details : layout.summary;
    const scrollLines = run
      ? screen === "details"
        ? wrappedDetailLines
        : wrapLines(summaryLines(run, now, event), viewport.width)
      : [];
    const navigationEvent: NavigationEvent = {
      type: "key",
      input,
      key,
      context: {
        terminalIsLargeEnough,
        projects,
        project,
        runs: projectRuns,
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
        pageSize: layout.details.height,
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
  const status = `${data.connection} · ${freshness}`;
  const sessionIndex = Math.max(
    0,
    sessions.findIndex((item) => item.id === session?.id),
  );
  const sessionLines = sessions.length
    ? sessions
        .slice(Math.max(0, sessionIndex - 1), sessionIndex + 3)
        .map(
          (item) =>
            `${item.id === session?.id ? ">" : " "} ${item.step} · invocation ${item.attempt} · ${item.outcome}`,
        )
    : ["No agent sessions recorded"];
  const detailsLogControl = detailLogSession
    ? columns < 120
      ? "l current log"
      : `l log: ${detailLogSession.step} invocation ${detailLogSession.attempt} (${detailLogSession.outcome})`
    : run?.stageLogs?.some(
          (item) => item.executionId === (run.executions?.at(-1)?.id ?? run.id),
        )
      ? "l stage diagnostic"
      : "";
  const controls = [
    screen === "details"
      ? detailsLogControl
      : sessions.length || run?.stageLogs?.length
        ? "l log"
        : "",
    run?.validation?.length
      ? columns < 120
        ? "v checks"
        : "v validation"
      : "",
    screen === "dashboard" && project
      ? project.paused
        ? "p resume"
        : "p pause"
      : "",
    available.stop ? "s stop" : "",
    available.retry ? "r retry" : "",
    available.recover ? "c recover" : "",
    "? help",
    "q close",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Box width={columns} height={rows} flexDirection="column">
      <Text bold color={colorFor("running")} wrap="truncate">
        {cells(
          `Agent Workflows · ${screen === "dashboard" ? "Monitor" : "Run details"}`,
          columns,
        )}
      </Text>
      <Text wrap="truncate">
        {cells(
          project
            ? `${project.id} · intake ${project.paused ? "paused" : "enabled"} · ${projectRuns.filter((item) => item.outcome === "queued").length} queued${project.blocked ? ` · BLOCKED: ${project.blocked}` : ""}`
            : "No projects registered. Start the runner to populate this view.",
          columns,
        )}
      </Text>
      <Box height={height} flexDirection="row" overflow="hidden">
        {screen === "details" ? (
          <Box
            borderStyle="round"
            width={columns}
            height={height}
            paddingX={1}
            flexDirection="column"
          >
            <Text bold>
              {wrappedDetailLines.length > layout.details.height
                ? `Details · lines ${detailOffset + 1}–${Math.min(detailOffset + layout.details.height, wrappedDetailLines.length)} of ${wrappedDetailLines.length}`
                : "Details"}
            </Text>
            <Lines
              lines={detailDocument}
              width={layout.details.width}
              height={layout.details.height}
              offset={detailOffset}
              outcome={run?.outcome}
            />
          </Box>
        ) : (
          <>
            {(wide || focus === "runs") && (
              <Box
                width={paneWidth}
                height={height}
                borderStyle="round"
                borderColor={focus === "runs" ? colorFor("running") : undefined}
                flexDirection="column"
                paddingX={1}
              >
                <Text bold>
                  {focus === "runs" ? "> " : ""}Runs · {projectRuns.length}
                </Text>
                <RunList
                  runs={projectRuns}
                  selected={run?.id}
                  width={layout.runs.width}
                  height={layout.runs.height}
                  now={now}
                />
              </Box>
            )}
            {(wide || focus !== "runs") && (
              <Box width={summaryWidth} height={height} flexDirection="column">
                {(wide || focus === "summary") && (
                  <Box
                    width={summaryWidth}
                    height={layout.summaryPanelHeight}
                    borderStyle="round"
                    borderColor={
                      focus === "summary" ? colorFor("running") : undefined
                    }
                    paddingX={1}
                    flexDirection="column"
                  >
                    <Text bold>
                      {focus === "summary" ? "> " : ""}Summary · Enter details
                    </Text>
                    <Lines
                      lines={
                        run
                          ? summaryLines(run, now, event)
                          : ["Select a run to inspect progress"]
                      }
                      width={layout.summary.width}
                      height={layout.summary.height}
                      offset={offset}
                    />
                  </Box>
                )}
                {(wide || focus === "sessions") && (
                  <Box
                    width={summaryWidth}
                    height={layout.sessionsPanelHeight}
                    borderStyle="round"
                    borderColor={
                      focus === "sessions" ? colorFor("running") : undefined
                    }
                    paddingX={1}
                    flexDirection="column"
                  >
                    <Text bold>
                      {focus === "sessions" ? "> " : ""}Agent sessions ·{" "}
                      {sessions.length} · l log
                    </Text>
                    <Lines
                      lines={sessionLines}
                      width={layout.sessions.width}
                      height={layout.sessions.height}
                    />
                  </Box>
                )}
              </Box>
            )}
          </>
        )}
      </Box>
      {showNotificationNotice && (
        <Text color={colorFor("running")} wrap="truncate">
          {cells(
            "Notifications enabled; delivery is best-effort and depends on terminal settings",
            columns,
          )}
        </Text>
      )}
      <Text
        wrap="truncate"
        color={
          data.connection.startsWith("Connection error")
            ? colorFor("failed")
            : undefined
        }
      >
        {cells(
          `${data.message ? `${data.message} · ` : ""}${columns < 120 ? status.replace("Database ", "DB ") : status} · runner liveness unverified · closing leaves workflows running`,
          columns,
        )}
      </Text>
      <Text color={colorFor("running")} wrap="truncate">
        {cells(
          [
            screen === "dashboard"
              ? "Tab pane · ↑↓ select/scroll · ←→ project · Enter details"
              : columns < 120
                ? "↑↓/Pg · Esc"
                : "↑↓ scroll · PgUp/PgDn page · Esc back",
            controls,
          ]
            .filter(Boolean)
            .join(" · "),
          columns,
        )}
      </Text>
    </Box>
  );
}
