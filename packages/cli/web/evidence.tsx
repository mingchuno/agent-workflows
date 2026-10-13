import type { RunRecord } from "@mingchuno/agent-workflows-core";
import type { ReactNode } from "react";
import type { RunEvidence } from "../src/web/contracts.js";
import styles from "./app.module.css";
import {
  durationBetween,
  executionDuration,
  safeLink,
  timestamp,
} from "./format.js";

function codeValue(value: string) {
  return <code>{value}</code>;
}

export function Facts({ entries }: { entries: Array<[string, ReactNode]> }) {
  return (
    <dl className={styles.facts}>
      {entries.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value ?? "Not recorded"}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Overview({ run }: { run: RunRecord }) {
  const attention = ["failed", "blocked", "cancelled"].includes(run.outcome);
  const delivery = run.readiness?.draft ? "Draft delivered" : "Completed";
  return (
    <>
      {attention ? (
        <div className={styles.attention}>
          <h3>
            {run.phase} · {run.outcome}
          </h3>
          <p>
            {run.error ??
              run.executions?.at(-1)?.error ??
              "No diagnostic recorded."}
          </p>
          <p>
            Inspect the checks, full diagnostics and relevant logs before
            retrying. Publication recovery continues this run; retry starts a
            new run.
          </p>
        </div>
      ) : (
        <p className={styles.lead}>
          {run.outcome === "running"
            ? "Workflow is running. You can close this monitor while work continues."
            : run.outcome === "queued"
              ? "Waiting for runner and project intake."
              : run.outcome === "superseded"
                ? "Review target changed. This run does not establish coverage of the new target."
                : run.outcome === "completed"
                  ? `${delivery}. Inspect Checks for delivery and validation evidence.`
                  : "Workflow finished. Inspect recorded evidence for its outcome."}
        </p>
      )}
      <Facts
        entries={[
          [
            "Outcome",
            <span
              className={styles.outcome}
              data-outcome={run.outcome}
              key="outcome"
            >
              {run.outcome}
            </span>,
          ],
          ["Phase", run.phase],
          ["Attempt", run.attempt],
          ["Execution duration", executionDuration(run.executions?.at(-1))],
          ["Branch", codeValue(run.branch || "Not recorded")],
          ["Updated", timestamp(run.updatedAt)],
        ]}
      />
      {safeLink(run.change?.url) && (
        <p>
          <a href={safeLink(run.change?.url)} target="_blank" rel="noreferrer">
            Open change request
          </a>
        </p>
      )}
      {run.readiness?.reasons.map((reason) => (
        <p key={reason}>{reason}</p>
      ))}
    </>
  );
}

export function Checks({ run }: { run: RunRecord }) {
  const draftStatus =
    run.outcome === "completed" ? "Draft delivered" : "Draft required";
  return (
    <>
      <h3>Delivery and readiness</h3>
      <p>
        {run.readiness
          ? run.readiness.draft
            ? `${draftStatus}; unresolved checks or findings remain.`
            : "Ready for review."
          : "Readiness not recorded."}
      </p>
      {run.readiness?.reasons.map((reason) => (
        <p key={reason}>{reason}</p>
      ))}
      <h3>Workflow validation</h3>
      {run.validation?.length ? (
        <div className={styles.tableScroll}>
          <table>
            <thead>
              <tr>
                <th>Command</th>
                <th>Result</th>
                <th>Finished</th>
              </tr>
            </thead>
            <tbody>
              {run.validation.map((check, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: immutable recorded evidence has positional identity and no component state.
                <tr key={`${index}:${check.log}`}>
                  <td>
                    <code>
                      {check.command} {check.args.join(" ")}
                    </code>
                  </td>
                  <td
                    className={
                      check.exitCode === 0 ? styles.success : styles.failure
                    }
                  >
                    exit {check.exitCode}
                  </td>
                  <td>{timestamp(check.finishedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>
          {run.validationStatus === "skipped"
            ? "Not configured (skipped)."
            : "Validation not recorded."}
        </p>
      )}
      <h3>Review</h3>
      <p>{run.review?.summary ?? "Review not recorded."}</p>
      {run.review?.findings.map((finding, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: immutable recorded evidence has positional identity and no component state.
        <div className={styles.finding} key={`${index}:${finding.body}`}>
          <strong>
            {finding.priority ?? "P2"} · {finding.path ?? "Summary"}
            {finding.line ? `:${finding.line}` : ""}
          </strong>
          <p>{finding.body}</p>
        </div>
      ))}
      {run.review?.limitations.map((limitation) => (
        <p key={limitation}>Review limitation: {limitation}</p>
      ))}
      <h3>Agent-reported validation</h3>
      <p className={styles.muted}>
        Reported by the agent; distinct from checks executed by the workflow.
      </p>
      {run.agentReport?.validation.length ? (
        run.agentReport.validation.map((check, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: immutable recorded evidence has positional identity and no component state.
          <p key={`${index}:${check.command}`}>
            {codeValue(check.command)} · {check.outcome}
            <br />
            {check.details}
          </p>
        ))
      ) : (
        <p>Not recorded.</p>
      )}
      {run.agentReport?.limitations.map((limitation) => (
        <p key={limitation}>Agent limitation: {limitation}</p>
      ))}
      {!!run.reviewRounds?.length && (
        <>
          <h3>Repair rounds</h3>
          {run.reviewRounds.map((round, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: immutable recorded evidence has positional identity and no component state.
            <section className={styles.finding} key={`round:${index}`}>
              <h4>Round {index + 1}</h4>
              <p>{round.review.summary}</p>
              <p>Validation: {round.validationStatus}</p>
              {round.validation.map((check, checkIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: immutable recorded evidence has positional identity and no component state.
                <p key={`${checkIndex}:${check.log}`}>
                  <code>
                    {check.command} {check.args.join(" ")}
                  </code>{" "}
                  · exit {check.exitCode}
                </p>
              ))}
            </section>
          ))}
        </>
      )}
    </>
  );
}

export function Executions({ run }: { run: RunRecord }) {
  if (!run.executions?.length) return <p>Execution not started.</p>;
  return (
    <ol className={styles.timeline}>
      {[...run.executions].reverse().map((execution, index) => (
        <li key={execution.id}>
          <h3>
            {index === 0
              ? "Current execution"
              : `Prior execution ${run.executions!.length - index}`}
          </h3>
          <p>
            <span className={styles.outcome} data-outcome={execution.outcome}>
              {execution.outcome}
            </span>{" "}
            · {execution.phase} · {executionDuration(execution)}
          </p>
          <Facts
            entries={[
              ["Created", timestamp(execution.createdAt)],
              ["Started", timestamp(execution.startedAt)],
              ["Finished", timestamp(execution.finishedAt)],
              [
                "Queue wait",
                durationBetween(
                  execution.createdAt,
                  execution.startedAt ?? execution.finishedAt,
                ),
              ],
              ["Execution ID", codeValue(execution.id)],
            ]}
          />
          {execution.recoveryOf && (
            <div className={styles.recovery}>
              <strong>Publication recovery</strong>
              <p>
                Continues the same run from {codeValue(execution.recoveryOf)}.
              </p>
              <p>
                Recovery gap:{" "}
                {durationBetween(
                  run.executions?.find(
                    (candidate) => candidate.id === execution.recoveryOf,
                  )?.finishedAt,
                  execution.createdAt,
                )}
              </p>
              <p>
                Reused steps:{" "}
                {execution.reusedSteps?.join(", ") || "None recorded"}
              </p>
            </div>
          )}
          {execution.error && (
            <pre className={styles.diagnostic}>{execution.error}</pre>
          )}
        </li>
      ))}
    </ol>
  );
}

export function Activity({ evidence }: { evidence: RunEvidence }) {
  const steps = evidence.events
    .filter((event) => event.kind === "step")
    .reverse();
  return (
    <>
      <h3>Recorded activity</h3>
      {steps.length ? (
        <ol className={styles.activity}>
          {steps.map((event) => {
            const payload = event.payload as { name?: string; status?: string };
            return (
              <li key={event.sequence}>
                <time>{timestamp(event.createdAt)}</time>
                <span>
                  <strong>{payload.name ?? "Step"}</strong> ·{" "}
                  {payload.status ?? "Recorded"}
                </span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p>No steps recorded.</p>
      )}
    </>
  );
}

export function Sessions({
  evidence,
  executionId,
}: {
  evidence: RunEvidence;
  executionId: string;
}) {
  const sessions = evidence.sessions.filter(
    (session) => !executionId || session.executionId === executionId,
  );
  return (
    <>
      <h3>Agent sessions</h3>
      {sessions.length ? (
        sessions.map((session) => (
          <section key={session.id} className={styles.session}>
            <h4>
              {session.step} · invocation {session.attempt}
            </h4>
            <Facts
              entries={[
                ["Provider", session.provider],
                ["Outcome", session.outcome],
                ["Session ID", session.sessionId ?? session.sessionState],
                ["Started", timestamp(session.startedAt)],
                ["Finished", timestamp(session.finishedAt)],
              ]}
            />
            <details>
              <summary>Profiles and invocation evidence</summary>
              <h4>Requested profile</h4>
              <pre className={styles.diagnostic}>
                {JSON.stringify(session.requested, null, 2)}
              </pre>
              <h4>Effective profile</h4>
              <pre className={styles.diagnostic}>
                {JSON.stringify(session.effective, null, 2)}
              </pre>
              <h4>Prompt</h4>
              <pre className={styles.diagnostic}>{session.prompt}</pre>
              {session.validationError && <p>{session.validationError}</p>}
            </details>
          </section>
        ))
      ) : (
        <p>No agent sessions recorded for this execution.</p>
      )}
    </>
  );
}

export function Diagnostics({ run }: { run: RunRecord }) {
  return (
    <>
      <h3>Full diagnostics</h3>
      {run.error && (
        <section aria-label="Run diagnostic">
          <h4>Run error</h4>
          <pre className={styles.diagnostic}>{run.error}</pre>
        </section>
      )}
      {[...(run.executions ?? [])]
        .reverse()
        .filter((execution) => execution.error)
        .map((execution) => (
          <section key={execution.id}>
            <h4>Execution {execution.id}</h4>
            <pre className={styles.diagnostic}>{execution.error}</pre>
          </section>
        ))}
      {!run.error && !run.executions?.some((execution) => execution.error) && (
        <p>
          No diagnostic recorded. Inspect relevant stage and validation logs
          when available.
        </p>
      )}
    </>
  );
}

export function Technical({ evidence }: { evidence: RunEvidence }) {
  const run = evidence.run;
  return (
    <>
      <h3>Technical details</h3>
      <Facts
        entries={[
          ["Run ID", codeValue(run.id)],
          ["Task key", codeValue(run.taskKey)],
          ["Checkout", codeValue(run.checkout)],
          ["Branch", codeValue(run.branch)],
          ["Base revision", codeValue(run.base ?? "Not recorded")],
          ["Head revision", codeValue(run.head ?? "Not recorded")],
          ["Retry of", run.retryOf],
          ["Created ISO", run.createdAt],
          ["Updated ISO", run.updatedAt],
        ]}
      />
      {safeLink(run.subject.url) && (
        <p>
          <a href={safeLink(run.subject.url)} target="_blank" rel="noreferrer">
            Open run subject
          </a>
        </p>
      )}
      <details>
        <summary>Recorded run and session metadata</summary>
        <pre className={styles.diagnostic}>
          {JSON.stringify({ run, sessions: evidence.sessions }, null, 2)}
        </pre>
      </details>
    </>
  );
}
