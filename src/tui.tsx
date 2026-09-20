import { readFile } from "node:fs/promises";
import { Box, Text, useApp, useInput } from "ink";
import { useState } from "react";
import { recoveryUnavailable } from "./recovery.js";
import { type MonitorSource, useMonitorData } from "./tui-data.js";

export type { MonitorSource } from "./tui-data.js";

export function Monitor({ source }: { source: MonitorSource }) {
  const { exit } = useApp();
  const [projectIndex, setProjectIndex] = useState(0),
    [runIndex, setRunIndex] = useState(0),
    [sessionIndex, setSessionIndex] = useState(0),
    [stepIndex, setStepIndex] = useState(0),
    [validationIndex, setValidationIndex] = useState(0);
  const {
    projects,
    project,
    projectRuns,
    run,
    sessions,
    events,
    message,
    setMessage,
    pending,
    action,
  } = useMonitorData(source, { projectIndex, runIndex });
  const [log, setLog] = useState("");
  const session = sessions[sessionIndex];
  const steps = events.filter((event) => event.kind === "step");
  const selectedStep = steps[stepIndex];
  const showLog = (path: string) => {
    void readFile(path, "utf8").then(
      (text) => setLog(text.split("\n").slice(-8).join("\n")),
      (error) => setMessage(`Log unavailable: ${String(error)}`),
    );
  };
  useInput((input, key) => {
    if (input === "q") {
      exit();
      return;
    }
    if (key.leftArrow || key.rightArrow) {
      setProjectIndex((index) =>
        Math.max(
          0,
          Math.min(projects.length - 1, index + (key.rightArrow ? 1 : -1)),
        ),
      );
      setRunIndex(0);
      setSessionIndex(0);
      setStepIndex(0);
      setValidationIndex(0);
      setLog("");
    }
    if (key.upArrow || key.downArrow) {
      setRunIndex((index) =>
        Math.max(
          0,
          Math.min(projectRuns.length - 1, index + (key.downArrow ? 1 : -1)),
        ),
      );
      setSessionIndex(0);
      setStepIndex(0);
      setValidationIndex(0);
      setLog("");
    }
    if (key.tab) {
      setSessionIndex((index) => (index + 1) % Math.max(sessions.length, 1));
      setLog("");
    }
    if (input === "l" && session) showLog(session.log);
    if (input === "[" || input === "]")
      setStepIndex((index) =>
        Math.max(
          0,
          Math.min(steps.length - 1, index + (input === "]" ? 1 : -1)),
        ),
      );
    if (input === "v" && run?.validation?.length) {
      const check = run.validation[validationIndex % run.validation.length]!;
      setMessage(`Validation: ${check.command} · exit ${check.exitCode}`);
      showLog(check.log);
      setValidationIndex((index) => index + 1);
    }
    if (pending) return;
    if (input === "p" && project)
      void action(project.paused ? "resume" : "pause", project.id);
    if (input === "s" && run) void action("stop", run.id);
    if (input === "r" && run) void action("retry", run.id);
    if (input === "c" && run) void action("recover", run.id);
  });
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Agent Workflows · Monitor</Text>
      <Text>
        ← → project · ↑ ↓ run · [ ] step/attempt · Tab session · l agent log · v
        validation log · p pause/resume · s stop · r retry · c recover · q close
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text bold>
          {project
            ? `${project.id} · ${project.paused ? "intake paused" : "intake enabled"} · ${projectRuns.filter((run) => run.outcome === "queued").length} queued`
            : "No projects registered. Start the runner to populate this view."}
        </Text>
        {project?.blocked && (
          <Text color="yellow">Blocked: {project.blocked}</Text>
        )}
        {projectRuns
          .slice(Math.max(0, runIndex - 1), runIndex + 2)
          .map((item) => (
            <Text key={item.id} inverse={item.id === run?.id}>
              {item.id === run?.id ? ">" : " "} #{item.issue.number} · attempt{" "}
              {item.attempt} · {item.outcome} · {item.phase}
            </Text>
          ))}
        {project && projectRuns.length === 0 && (
          <Text>No runs yet. Eligible issues appear after polling.</Text>
        )}
      </Box>
      {run && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Run {run.id}</Text>
          <Text>{run.issue.title}</Text>
          {run.error && <Text color="red">{run.error}</Text>}
          <Text>
            Recovery:{" "}
            {recoveryUnavailable(run) ??
              project?.blocked ??
              (projectRuns.some(
                (item) =>
                  item.taskKey === run.taskKey && item.attempt > run.attempt,
              )
                ? "A newer attempt has superseded this run"
                : `from ${run.phase}; runner checks required`)}
          </Text>
          {run.executions?.map((execution) => (
            <Text key={execution.id}>
              Execution {execution.id} · {execution.outcome} / {execution.phase}
              {execution.recoveryOf
                ? ` · recovered from ${execution.recoveryOf} · reused: ${execution.reusedSteps?.join(", ")}`
                : ""}
            </Text>
          ))}
          <Text>
            Validation:{" "}
            {run.validation
              ?.map((check) => `${check.command}: exit ${check.exitCode}`)
              .join(" · ") || "No checks recorded"}
          </Text>
          <Text>
            Step/attempt event {steps.length ? stepIndex + 1 : 0}/{steps.length}
            :{" "}
            {selectedStep
              ? JSON.stringify(selectedStep.payload)
              : "No steps recorded"}
          </Text>
          <Text bold>Agent sessions · {sessions.length}</Text>
          {session ? (
            <>
              <Text>
                {session.step} · invocation {session.attempt} ·{" "}
                {session.outcome}
              </Text>
              <Text>Session: {session.sessionId ?? session.sessionState}</Text>
              <Text>Requested: {JSON.stringify(session.requested)}</Text>
              <Text>Effective: {JSON.stringify(session.effective)}</Text>
              <Text>Log: {session.log}</Text>
            </>
          ) : (
            <Text>No agent sessions recorded</Text>
          )}
          {log && <Text>{log}</Text>}
        </Box>
      )}
      <Box marginTop={1}>
        <Text>{message}</Text>
      </Box>
      <Text dimColor>
        Closing this monitor leaves the runner and its tasks running.
      </Text>
    </Box>
  );
}
