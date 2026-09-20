import { useEffect, useState } from "react";
import type { RunRecord } from "./domain.js";
import type {
  EventRecord,
  InvocationRecord,
  ProjectState,
  Store,
} from "./store.js";

export interface MonitorSource {
  projects: Store["projects"];
  runs: Store["runs"];
  invocations: Store["invocations"];
  events: Store["events"];
  request: Store["request"];
  commands: Store["commands"];
}
export function useMonitorData(
  source: MonitorSource,
  selection: { projectIndex: number; runIndex: number },
) {
  const { projectIndex, runIndex } = selection;
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [sessions, setSessions] = useState<InvocationRecord[]>([]),
    [events, setEvents] = useState<EventRecord[]>([]);
  const [message, setMessage] = useState("Connecting…"),
    [pending, setPending] = useState<string>();
  const project = projects[projectIndex];
  const projectRuns = runs.filter((run) => run.projectId === project?.id);
  const run = projectRuns[runIndex];
  const selectedRunId = run?.id;
  useEffect(() => {
    let closed = false,
      busy = false;
    const update = async () => {
      if (busy) return;
      busy = true;
      try {
        const [nextProjects, nextRuns] = await Promise.all([
          source.projects(),
          source.runs(),
        ]);
        if (closed) return;
        setProjects(nextProjects);
        setRuns(nextRuns);
        if (selectedRunId) {
          const [nextSessions, nextEvents] = await Promise.all([
            source.invocations(selectedRunId),
            source.events(0, selectedRunId),
          ]);
          if (closed) return;
          setSessions(nextSessions);
          setEvents(
            nextEvents.filter((event) => event.runId === selectedRunId),
          );
        } else {
          setSessions([]);
          setEvents([]);
        }
        if (pending) {
          const command = (await source.commands()).find(
            (command) => command.id === pending,
          );
          if (command && command.status !== "pending") {
            setMessage(
              `${command.kind}: ${command.status}${command.error ? ` — ${command.error}` : ""}`,
            );
            setPending(undefined);
          }
        } else
          setMessage((current) =>
            current === "Connecting…" ? "Connected" : current,
          );
      } catch (error) {
        if (!closed) setMessage(`Connection error: ${String(error)}`);
      } finally {
        busy = false;
      }
    };
    void update();
    const timer = setInterval(() => void update(), 400);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, [source, selectedRunId, pending]);
  const action = async (
    kind: "pause" | "resume" | "stop" | "retry" | "recover",
    target: string,
  ) => {
    setMessage(`${kind}: pending`);
    setPending("submitting");
    try {
      setPending(await source.request(kind, target));
    } catch (error) {
      setPending(undefined);
      setMessage(`${kind}: failed — ${String(error)}`);
    }
  };
  return {
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
  };
}
