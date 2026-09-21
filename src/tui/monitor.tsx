import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useEffect, useState } from "react";
import { minimumTerminalSize } from "./constants.js";
import { type MonitorSource, useMonitorData } from "./data.js";
import { ConfirmDialog, HelpDialog } from "./dialogs.js";
import { cells, colorFor, wrapLines } from "./format.js";
import { monitorLayout } from "./layout.js";
import { type LogSource, LogViewer } from "./log.js";
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

type Focus = "runs" | "summary" | "sessions";
type Screen = "dashboard" | "details";
type Confirmation = {
  kind: "stop" | "retry" | "recover";
  runId: string;
  title: string;
};
const focuses: Focus[] = ["runs", "summary", "sessions"];
const statusRefreshIntervalMs = 1_000;
const actionDescriptions = {
  stop: "Cancel this run and wait for its active local work to stop.",
  retry: "Create a new run and branch; execute the workflow again.",
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
  const [selection, setSelection] = useState<{
    projectId?: string;
    runId?: string;
  }>({});
  const data = useMonitorData(source, selection, notificationWriter);
  const { projects, project, projectRuns, run, sessions, events } = data;
  const [focus, setFocus] = useState<Focus>("runs");
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [sessionId, setSessionId] = useState<string>();
  const [stepSequence, setStepSequence] = useState<number>();
  const [offset, setOffset] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [logs, setLogs] = useState<{ sources: LogSource[]; initial: number }>();
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
    // Pin default selections by identity before incoming rows can reorder them.
    setSelection((current) =>
      current.projectId === project?.id && current.runId === run?.id
        ? current
        : { projectId: project?.id, runId: run?.id },
    );
  }, [project?.id, run?.id]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset navigation when the selected run identity changes.
  useEffect(() => {
    setSessionId(undefined);
    setStepSequence(undefined);
    setOffset(0);
    setConfirmation(undefined);
  }, [run?.id]);
  const selectProject = (delta: number) => {
    const index = projects.findIndex((item) => item.id === project?.id);
    const next =
      projects[Math.max(0, Math.min(projects.length - 1, index + delta))];
    setSelection({ projectId: next?.id });
    setFocus("runs");
    setOffset(0);
  };
  const openAgentLog = (candidates = sessions, initialSession = session) => {
    if (!candidates.length) return;
    setLogs({
      sources: candidates.map((item) => ({
        path: item.log,
        label: `${item.step} · invocation ${item.attempt}`,
      })),
      initial: Math.max(
        0,
        candidates.findIndex((item) => item.id === initialSession?.id),
      ),
    });
  };
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
  useInput((input, key) => {
    if (key.ctrl || key.meta || key.eventType === "release") return;
    const terminalIsLargeEnough =
      columns >= minimumTerminalSize.columns &&
      rows >= minimumTerminalSize.rows;
    if (logs && terminalIsLargeEnough) return;
    if (terminalIsLargeEnough && (confirmation || helpOpen)) return;
    if (input === "q") {
      exit();
      return;
    }
    if (!terminalIsLargeEnough) return;
    if (key.escape) {
      setScreen("dashboard");
      setFocus("runs");
      setOffset(0);
      return;
    }
    if (input === "?") {
      setHelpOpen(true);
      return;
    }
    if (key.tab && screen === "dashboard") {
      setFocus(focuses[(focuses.indexOf(focus) + (key.shift ? 2 : 1)) % 3]!);
      setOffset(0);
    }
    if (input === "a" && screen === "dashboard") {
      setScreen("dashboard");
      setFocus("sessions");
    }
    if (key.leftArrow && screen === "dashboard") selectProject(-1);
    if (key.rightArrow && screen === "dashboard") selectProject(1);
    if (key.return && run && screen === "dashboard") {
      setScreen("details");
      setOffset(0);
    }
    if (input === "l")
      screen === "details"
        ? openAgentLog(executionSessions, detailLogSession)
        : openAgentLog();
    if (input === "v" && run?.validation?.length)
      setLogs({
        sources: run.validation.map((item) => ({
          path: item.log,
          label: `${item.command} · exit ${item.exitCode}`,
        })),
        initial: 0,
      });
    if (screen === "dashboard" && (input === "[" || input === "]")) {
      const index = events.findIndex(
        (item) => item.sequence === event?.sequence,
      );
      setStepSequence(
        events[
          Math.max(
            0,
            Math.min(events.length - 1, index + (input === "]" ? 1 : -1)),
          )
        ]?.sequence,
      );
    }
    if (key.end && screen === "dashboard") setStepSequence(undefined);
    if (key.upArrow || key.downArrow || key.pageUp || key.pageDown) {
      const delta = key.upArrow || key.pageUp ? -1 : 1;
      if (screen === "details" || focus === "summary") {
        const lines = run
          ? screen === "details"
            ? detailDocument
            : summaryLines(run, now, event)
          : [];
        const viewport = screen === "details" ? layout.details : layout.summary;
        setOffset((value) => {
          const maximum = Math.max(
            0,
            (screen === "details"
              ? wrapDetailLines(lines, viewport.width)
              : wrapLines(lines, viewport.width)
            ).length - viewport.height,
          );
          const current =
            screen === "details" ? Math.min(value, maximum) : value;
          return Math.max(
            0,
            Math.min(
              maximum,
              current +
                delta *
                  (key.pageUp || key.pageDown ? layout.details.height : 1),
            ),
          );
        });
      } else if (focus === "sessions") {
        const index = sessions.findIndex((item) => item.id === session?.id);
        setSessionId(
          sessions[Math.max(0, Math.min(sessions.length - 1, index + delta))]
            ?.id,
        );
      } else {
        const index = projectRuns.findIndex((item) => item.id === run?.id);
        setSelection({
          projectId: project?.id,
          runId:
            projectRuns[
              Math.max(0, Math.min(projectRuns.length - 1, index + delta))
            ]?.id,
        });
      }
    }
    if (input === "p" && screen === "dashboard" && project && !data.pending)
      void data.action(project.paused ? "resume" : "pause", project.id);
    const kind =
      input === "s"
        ? "stop"
        : input === "r"
          ? "retry"
          : input === "c"
            ? "recover"
            : undefined;
    if (kind && run && available[kind])
      setConfirmation({
        kind,
        runId: run.id,
        title: `#${run.issue.number} ${run.issue.title}`,
      });
  });
  if (columns < minimumTerminalSize.columns || rows < minimumTerminalSize.rows)
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
  if (helpOpen)
    return (
      <HelpDialog
        columns={columns}
        rows={rows}
        onClose={() => setHelpOpen(false)}
      />
    );
  if (confirmation)
    return (
      <ConfirmDialog
        columns={columns}
        rows={rows}
        title={`Confirm ${confirmation.kind}`}
        subject={confirmation.title}
        description={actionDescriptions[confirmation.kind]}
        available={
          run?.id === confirmation.runId && available[confirmation.kind]
        }
        onCancel={() => setConfirmation(undefined)}
        onConfirm={() => {
          void data.action(confirmation.kind, confirmation.runId);
          setConfirmation(undefined);
        }}
      />
    );
  if (logs)
    return (
      <LogViewer
        {...logs}
        columns={columns}
        rows={rows}
        onBack={() => setLogs(undefined)}
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
    : "";
  const controls = [
    screen === "details" ? detailsLogControl : sessions.length ? "l log" : "",
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
