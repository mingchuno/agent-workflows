import type { RunRecord } from "@mingchuno/agent-workflows-core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { MonitorCommand, RunEvidence } from "../src/web/contracts.js";
import { Actions } from "./actions.js";
import { readMonitor } from "./api.js";
import styles from "./app.module.css";
import {
  Activity,
  Checks,
  Diagnostics,
  Executions,
  Overview,
  Sessions,
  Technical,
} from "./evidence.js";
import { executionDuration, reference } from "./format.js";
import { Logs } from "./logs.js";

const sections = [
  "Overview",
  "Activity",
  "Checks",
  "Executions",
  "Sessions",
  "Diagnostics",
  "Technical",
  "Logs",
  "Actions",
] as const;
type Section = (typeof sections)[number];

export function RunWorkspace({
  run,
  disabled,
  submit,
}: {
  run: RunRecord;
  disabled: boolean;
  submit: (command: MonitorCommand) => void;
}) {
  const [section, setSection] = useState<Section>("Overview");
  const [executionId, setExecutionId] = useState("");
  const evidence = useQuery({
    queryKey: ["evidence", run.id],
    queryFn: ({ signal }) =>
      readMonitor<RunEvidence>(
        `/api/runs/${encodeURIComponent(run.id)}`,
        signal,
      ),
    refetchInterval: 1000,
  });
  const recorded = evidence.data;
  const current = recorded?.run ?? run;
  return (
    <section className={styles.content}>
      <div className={styles.identity}>
        <h2>{run.subject.title}</h2>
        <p>
          {reference(run)} · attempt {run.attempt}
        </p>
        <p>
          <span className={styles.outcome} data-outcome={run.outcome}>
            {run.outcome}
          </span>{" "}
          · {run.phase} · {executionDuration(run.executions?.at(-1))}
        </p>
      </div>
      <p className={styles.screenReaderOnly} aria-live="polite">
        {`${reference(run)} is ${run.outcome} · ${run.phase}`}
      </p>
      <nav className={styles.sections} aria-label="Run sections">
        {sections.map((name) => (
          <button
            key={name}
            type="button"
            aria-current={name === section ? "page" : undefined}
            onClick={() => setSection(name)}
          >
            {name}
          </button>
        ))}
      </nav>
      {evidence.isError && (
        <div role="alert" className={styles.attention}>
          <strong>Selected-run evidence unavailable.</strong>
          <p>
            {evidence.error.message} Actions are disabled until evidence is
            current.
          </p>
          <button type="button" onClick={() => void evidence.refetch()}>
            Retry evidence
          </button>
        </div>
      )}
      {evidence.isPending && <p>Loading run evidence…</p>}
      {recorded && (
        <div className={styles.evidence}>
          {(section === "Sessions" || section === "Logs") && (
            <label className={styles.executionSelect}>
              Execution
              <select
                value={executionId}
                onChange={(event) => setExecutionId(event.target.value)}
              >
                <option value="">All executions</option>
                {[...(current.executions ?? [])]
                  .reverse()
                  .map((execution, index) => (
                    <option key={execution.id} value={execution.id}>
                      {index === 0 ? "Current" : "Prior"} · {execution.outcome}{" "}
                      · {execution.id}
                    </option>
                  ))}
              </select>
            </label>
          )}
          {section === "Overview" && <Overview run={current} />}
          {section === "Activity" && <Activity evidence={recorded} />}
          {section === "Checks" && <Checks run={current} />}
          {section === "Executions" && <Executions run={current} />}
          {section === "Sessions" && (
            <Sessions evidence={recorded} executionId={executionId} />
          )}
          {section === "Diagnostics" && <Diagnostics run={current} />}
          {section === "Technical" && <Technical evidence={recorded} />}
          {section === "Logs" && (
            <Logs
              runId={run.id}
              logs={recorded.logs.filter(
                (log) =>
                  !executionId ||
                  !log.executionId ||
                  log.executionId === executionId,
              )}
            />
          )}
          {section === "Actions" && (
            <Actions
              evidence={recorded}
              disabled={disabled || evidence.isError}
              submit={submit}
            />
          )}
        </div>
      )}
    </section>
  );
}
