import { useQuery } from "@tanstack/react-query";
import { useDeferredValue, useEffect, useState } from "react";
import { runFilters } from "../src/monitor/filters.js";
import type { MonitorSnapshot } from "../src/web/contracts.js";
import { readMonitor, useOperatorCommands } from "./api.js";
import styles from "./app.module.css";
import { ConfigurationView } from "./configuration.js";
import { executionDuration, reference } from "./format.js";
import { selectMonitorRuns } from "./selection.js";
import { RunWorkspace } from "./workspace.js";

const fixturePreview = import.meta.env.VITE_MONITOR_FIXTURES === "true";

export function App() {
  const [showConfiguration, setShowConfiguration] = useState(false);
  const [projectId, setProjectId] = useState<string>();
  const [runId, setRunId] = useState<string>();
  const [filter, setFilter] = useState("All");
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query);
  const snapshot = useQuery({
    queryKey: ["snapshot", filter, search],
    queryFn: ({ signal }) =>
      readMonitor<MonitorSnapshot>(
        `/api/snapshot?${new URLSearchParams({ filter, query: search })}`,
        signal,
      ),
    refetchInterval: 1000,
  });
  const commands = useOperatorCommands(snapshot.data);
  const { project, projectRuns, visibleRuns, run } = selectMonitorRuns(
    snapshot.data,
    { projectId, runId },
  );
  const selectedProjectId = project?.id;
  const selectedRunId = run?.id;
  useEffect(() => {
    if (selectedProjectId) setProjectId(selectedProjectId);
    if (selectedRunId) setRunId(selectedRunId);
  }, [selectedProjectId, selectedRunId]);
  const unavailable = fixturePreview || snapshot.isError || !snapshot.data;
  return (
    <div className={styles.shell}>
      <a className={styles.skip} href="#workspace">
        Skip to workspace
      </a>
      <aside className={styles.rail} aria-label="Projects">
        <h1>Agent Workflows</h1>
        <p className={styles.railNote}>
          {fixturePreview ? "Read-only fixtures" : "Local monitor"}
        </p>
        <h2>Projects</h2>
        {snapshot.data?.projects.map((item) => (
          <button
            type="button"
            key={item.id}
            aria-pressed={item.id === project?.id}
            className={styles.project}
            onClick={() => {
              setProjectId(item.id);
              setRunId(undefined);
            }}
          >
            <strong>{item.id}</strong>
            <span>
              {item.blocked
                ? "Blocked"
                : item.paused
                  ? "Intake paused"
                  : "Intake enabled"}
            </span>
          </button>
        ))}
        <p className={styles.railFooter}>
          Closing this monitor leaves workflows running.
        </p>
      </aside>
      <aside className={styles.runPane} aria-label="Runs">
        <div className={styles.runHeading}>
          <h2>Runs</h2>
          <span>{projectRuns.length} recorded</span>
        </div>
        <label>
          Search runs
          <input
            type="search"
            value={query}
            maxLength={256}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Subject, reference, or run ID"
          />
        </label>
        <label>
          Outcome filter
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            {runFilters.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        <div className={styles.runList}>
          {visibleRuns.map((item) => (
            <button
              type="button"
              className={styles.runItem}
              key={item.id}
              aria-pressed={item.id === run?.id}
              onClick={() => setRunId(item.id)}
            >
              <span className={styles.runReference}>
                {reference(item)} · attempt {item.attempt}
              </span>
              <strong>{item.subject.title}</strong>
              <span>
                <span className={styles.outcome} data-outcome={item.outcome}>
                  {item.outcome}
                </span>{" "}
                · {item.phase}
              </span>
              <span className={styles.muted}>
                {executionDuration(item.executions?.at(-1))}
              </span>
              {!snapshot.data?.visibleRunIds.includes(item.id) && (
                <span className={styles.muted}>
                  Selected run · outside this filter
                </span>
              )}
            </button>
          ))}
        </div>
        {!visibleRuns.length && (
          <p className={styles.empty}>
            {projectRuns.length
              ? "No runs match this search and filter."
              : "No runs yet. Waiting for eligible work."}
          </p>
        )}
      </aside>
      <main id="workspace" className={styles.workspace} tabIndex={-1}>
        <header className={styles.topbar}>
          <span>{project?.id ?? "Connecting"}</span>
          <span className={styles.connection}>
            {snapshot.isError
              ? "Connection unavailable"
              : fixturePreview
                ? "Fixture preview · read-only"
                : snapshot.data
                  ? "Connected to local monitor"
                  : "Connecting…"}
          </span>
        </header>
        {snapshot.isError && (
          <div role="alert" className={styles.warning}>
            <strong>
              {snapshot.data
                ? "Displayed evidence is stale."
                : "Cannot connect to the monitor."}
            </strong>
            <p>{snapshot.error.message}</p>
            <button type="button" onClick={() => void snapshot.refetch()}>
              Try again
            </button>
          </div>
        )}
        <div className={styles.toolbar}>
          <button
            type="button"
            aria-pressed={showConfiguration}
            onClick={() => setShowConfiguration((current) => !current)}
          >
            {showConfiguration ? "Back to runs" : "View configuration"}
          </button>
          <button
            type="button"
            disabled={!project || unavailable || commands.pending}
            onClick={() =>
              commands.submit({
                kind: project?.paused ? "resume" : "pause",
                target: project!.id,
              })
            }
          >
            {project?.paused ? "Resume intake" : "Pause intake"}
          </button>
          <button
            type="button"
            disabled={unavailable || commands.pending}
            onClick={() => commands.submit({ kind: "reload", target: "" })}
          >
            Reload configuration
          </button>
        </div>
        {project?.blocked && (
          <div className={styles.warning} role="alert">
            <strong>Project blocked</strong>
            <p>{project.blocked}</p>
          </div>
        )}
        <div
          role="status"
          className={styles.commandNotice}
          data-visible={!!commands.notice}
        >
          {commands.notice}
        </div>
        {showConfiguration ? (
          <ConfigurationView />
        ) : run ? (
          <RunWorkspace
            key={run.id}
            run={run}
            disabled={unavailable || commands.pending}
            submit={commands.submit}
          />
        ) : (
          <section className={styles.emptyWorkspace}>
            <h2>
              {snapshot.isPending
                ? "Connecting to your workflows"
                : "Ready for the next run"}
            </h2>
            <p>
              Select a recorded run to inspect its activity, validation and
              execution evidence.
            </p>
          </section>
        )}
      </main>
    </div>
  );
}
