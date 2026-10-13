import { useEffect, useRef, useState } from "react";
import type { Configuration } from "../config.js";
import { type RunRecord, subjectReference } from "../domain.js";
import { discoverRuns, type RunFilter } from "../monitor/discovery.js";
import type {
  EventRecord,
  InvocationRecord,
  ProjectState,
  Store,
} from "../store.js";
import { tuiRefreshIntervalMs } from "./constants.js";
import {
  ExecutionNotificationObserver,
  type ExecutionNotificationWriter,
} from "./notifications.js";

export interface MonitorSource {
  configuration?: () => Promise<Configuration>;
  projects: Store["projects"];
  runs: Store["runs"];
  invocations: Store["invocations"];
  events: Store["events"];
  request: Store["request"];
  commands: Store["commands"];
}
export type MonitorAction =
  | "pause"
  | "resume"
  | "stop"
  | "retry"
  | "retry-refresh"
  | "recover"
  | "reload";

export function useMonitorData(
  source: MonitorSource,
  selection: { projectId?: string; runId?: string },
  notificationWriter?: ExecutionNotificationWriter,
  discovery: { filter: RunFilter; query: string } = {
    filter: "All",
    query: "",
  },
) {
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [detail, setDetail] = useState<{
    runId?: string;
    sessions: InvocationRecord[];
    events: EventRecord[];
  }>({ sessions: [], events: [] });
  const [connection, setConnection] = useState("Connecting…");
  const [snapshotStatus, setSnapshotStatus] = useState<
    "loading" | "connected" | "unavailable" | "stale"
  >("loading");
  const hasSnapshot = useRef(false);
  const [detailError, setDetailError] = useState<{
    runId: string;
    message: string;
  }>();
  const [stateNotice, setStateNotice] = useState<string>();
  const previousState = useRef<
    | {
        runId: string;
        outcome: string;
        phase: string;
      }
    | undefined
  >(undefined);
  const [lastUpdated, setLastUpdated] = useState<number>();
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<string>();
  const pendingRef = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const notificationObserver = useRef(
    notificationWriter
      ? new ExecutionNotificationObserver(notificationWriter)
      : undefined,
  ).current;
  const project =
    projects.find((item) => item.id === selection.projectId) ?? projects[0];
  const projectRuns = runs.filter((item) => item.projectId === project?.id);
  const discovered = discoverRuns(
    projectRuns,
    discovery.filter,
    discovery.query,
  );
  // Keep the selected record visible if polling changes its filter classification.
  const visibleRuns = projectRuns.filter(
    (item) => item.id === selection.runId || discovered.includes(item),
  );
  const run =
    visibleRuns.find((item) => item.id === selection.runId) ?? visibleRuns[0];
  const selectedRunId = run?.id;
  const observedOutcome = run?.outcome;
  const observedPhase = run?.phase;
  const observedSubject = run ? subjectReference(run.subject) : "";
  useEffect(() => {
    const previous = previousState.current;
    previousState.current =
      selectedRunId && observedOutcome && observedPhase
        ? {
            runId: selectedRunId,
            outcome: observedOutcome,
            phase: observedPhase,
          }
        : undefined;
    if (!selectedRunId || previous?.runId !== selectedRunId) {
      setStateNotice(undefined);
      return;
    }
    if (
      previous.outcome === observedOutcome &&
      previous.phase === observedPhase
    )
      return;
    setStateNotice(
      `State changed: ${observedSubject} ${previous.outcome} -> ${observedOutcome} (${observedPhase})`,
    );
    const timer = setTimeout(() => setStateNotice(undefined), 3000);
    return () => clearTimeout(timer);
  }, [selectedRunId, observedOutcome, observedPhase, observedSubject]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let closed = false;
    let busy = false;
    let cursor = 0;
    let history: EventRecord[] = [];
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
        notificationObserver?.observe(nextRuns);
        hasSnapshot.current = true;
        setSnapshotStatus("connected");
        setConnection("Database connected");
        setLastUpdated(Date.now());
        if (selectedRunId) {
          try {
            const [sessions, nextEvents] = await Promise.all([
              source.invocations(selectedRunId),
              source.events(cursor, selectedRunId),
            ]);
            if (closed) return;
            const fresh = nextEvents.filter((event) => event.sequence > cursor);
            if (fresh.length)
              cursor = Math.max(...fresh.map((event) => event.sequence));
            history = [
              ...history,
              ...fresh.filter(
                (event) =>
                  event.runId === selectedRunId && event.kind === "step",
              ),
            ];
            setDetail({ runId: selectedRunId, sessions, events: history });
            setDetailError(undefined);
          } catch (error) {
            if (!closed)
              setDetailError({
                runId: selectedRunId,
                message: `Selected-run evidence unavailable: ${String(error)}`,
              });
          }
        }
      } catch (error) {
        if (!closed) {
          setSnapshotStatus(hasSnapshot.current ? "stale" : "unavailable");
          setConnection(`Connection error: ${String(error)}`);
        }
      } finally {
        busy = false;
      }
    };
    void update();
    const timer = setInterval(() => void update(), tuiRefreshIntervalMs);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, [source, selectedRunId, notificationObserver]);

  useEffect(() => {
    if (!pending || pending === "submitting") return;
    let closed = false;
    let busy = false;
    const update = async () => {
      if (busy) return;
      busy = true;
      try {
        const command = (await source.commands()).find(
          (item) => item.id === pending,
        );
        if (closed || !command || command.status === "pending") return;
        setMessage(
          `${command.kind}: ${command.status}${command.error ? ` — ${command.error}` : ""}`,
        );
        pendingRef.current = undefined;
        setPending(undefined);
      } catch (error) {
        if (!closed)
          setMessage(
            `Command pending; cannot read acknowledgement: ${String(error)}`,
          );
      } finally {
        busy = false;
      }
    };
    void update();
    const timer = setInterval(() => void update(), tuiRefreshIntervalMs);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, [source, pending]);

  const action = async (kind: MonitorAction, target: string) => {
    if (pendingRef.current) return;
    pendingRef.current = "submitting";
    setPending("submitting");
    setMessage(`${kind}: pending — waiting for runner`);
    try {
      const id = await source.request(kind, target);
      if (!mounted.current) return;
      pendingRef.current = id;
      setPending(id);
    } catch (error) {
      if (!mounted.current) return;
      pendingRef.current = undefined;
      setPending(undefined);
      setMessage(`${kind}: submission failed — ${String(error)}`);
    }
  };
  return {
    projects,
    project,
    projectRuns,
    visibleRuns,
    run,
    sessions: detail.runId === selectedRunId ? detail.sessions : [],
    events: detail.runId === selectedRunId ? detail.events : [],
    connection,
    snapshotStatus,
    detailError:
      detailError && detailError.runId === selectedRunId
        ? detailError.message
        : undefined,
    stateNotice,
    lastUpdated,
    message,
    pending,
    action,
  };
}
