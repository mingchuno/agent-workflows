import { useQuery } from "@tanstack/react-query";
import { useDeferredValue, useEffect, useRef, useState } from "react";
import { runFilters } from "../src/monitor/filters.js";
import type { MonitorSnapshot } from "../src/web/contracts.js";
import { readMonitor, useOperatorCommands } from "./api.js";
import styles from "./app.module.css";
import { ConfigurationView } from "./configuration.js";
import { executionDuration, reference } from "./format.js";
import { selectMonitorRuns } from "./selection.js";
import { WorkItemsView } from "./work-items.js";
import { RunWorkspace } from "./workspace.js";

const fixturePreview = import.meta.env.VITE_MONITOR_FIXTURES === "true";

export function App() {
  const [view, setView] = useState<"projects" | "configuration" | "work-items">(
    "projects",
  );
  const showConfiguration = view === "configuration";
  const [runPickerExpanded, setRunPickerExpanded] = useState(false);
  const runPickerToggle = useRef<HTMLButtonElement>(null);
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
    <div className={styles.shell} data-configuration={view !== "projects"}>
      <a className={styles.skip} href="#workspace">
        Skip to workspace
      </a>
      <aside className={styles.rail} aria-label="Application navigation">
        <h1>Agent Workflows</h1>
        <p className={styles.railNote}>
          {fixturePreview ? "Read-only fixtures" : "Local monitor"}
        </p>
        <nav className={styles.primaryNavigation} aria-label="Monitor views">
          <button
            type="button"
            className={styles.project}
            aria-current={view === "projects" ? "page" : undefined}
            onClick={() => setView("projects")}
          >
            Projects
          </button>
          <button
            type="button"
            className={styles.project}
            aria-current={showConfiguration ? "page" : undefined}
            onClick={() => setView("configuration")}
          >
            Configuration
          </button>
          <button
            type="button"
            className={styles.project}
            aria-current={view === "work-items" ? "page" : undefined}
            onClick={() => setView("work-items")}
          >
            Work Items
          </button>
        </nav>
        {!showConfiguration && (
          <div className={styles.projectNavigation}>
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
          </div>
        )}
        <p className={styles.railFooter}>
          Closing this monitor leaves workflows running.
        </p>
      </aside>
      <aside
        className={styles.runPane}
        aria-label="Runs"
        hidden={view !== "projects"}
        data-expanded={runPickerExpanded}
      >
        <div className={styles.runHeading}>
          <h2>Runs</h2>
          <span>{projectRuns.length} recorded</span>
          <button
            type="button"
            className={styles.runPickerToggle}
            ref={runPickerToggle}
            aria-expanded={runPickerExpanded}
            aria-controls="run-picker"
            onClick={() => setRunPickerExpanded((current) => !current)}
          >
            {runPickerExpanded ? "Hide runs" : "Choose run"}
          </button>
        </div>
        <div id="run-picker" className={styles.runPicker}>
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
                onClick={() => {
                  setRunId(item.id);
                  setRunPickerExpanded(false);
                  if (runPickerToggle.current?.getClientRects().length) {
                    runPickerToggle.current.focus();
                  }
                }}
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
        </div>
      </aside>
      <main id="workspace" className={styles.workspace} tabIndex={-1}>
        <header className={styles.topbar}>
          <span>
            {showConfiguration
              ? "Active configuration"
              : view === "work-items"
                ? "Work Items"
                : (project?.id ?? "Connecting")}
          </span>
          <span className={styles.connection}>
            {snapshot.isError
              ? "Connection unavailable"
              : fixturePreview
                ? "Fixture preview · read-only"
                : snapshot.data
                  ? "Connected to local monitor"
                  : "Connecting…"}
          </span>
          {!showConfiguration && (
            <div className={styles.toolbar}>
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
            </div>
          )}
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
        {!showConfiguration && project?.blocked && (
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
          <ConfigurationView
            reloadDisabled={unavailable || commands.pending}
            onReload={() => commands.submit({ kind: "reload", target: "" })}
          />
        ) : view === "work-items" ? (
          <WorkItemsView projectId={project?.id} disabled={unavailable} />
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
