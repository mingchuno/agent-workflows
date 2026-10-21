import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type {
  WorkApproval,
  WorkItemsSnapshot,
  WorkItemView,
} from "../src/web/contracts.js";
import { readMonitor } from "./api.js";
import styles from "./app.module.css";

export function WorkItemsView({
  projectId,
  disabled,
}: {
  projectId?: string;
  disabled: boolean;
}) {
  const client = useQueryClient();
  const [selectedId, setSelectedId] = useState<string>();
  const [confirmation, setConfirmation] = useState<{
    id: string;
    title: string;
    approval: WorkApproval;
  }>();
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [notice, setNotice] = useState("");
  const snapshot = useQuery({
    queryKey: ["work-items"],
    queryFn: ({ signal }) =>
      readMonitor<WorkItemsSnapshot>("/api/work-items", signal),
    refetchInterval: 1000,
    retry: false,
  });
  const items =
    snapshot.data?.items.filter(
      (item) => !projectId || item.work.projectId === projectId,
    ) ?? [];
  const selected =
    items.find((item) => item.work.id === selectedId) ?? items[0];
  const gate = selected?.decision.awaitingGate;
  const unavailable = disabled || pending || snapshot.isError || !snapshot.data;
  const confirmationCurrent =
    confirmation &&
    selected?.work.id === confirmation.id &&
    selected.work.revision === confirmation.approval.revision &&
    gate === confirmation.approval.gate;
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirmation) cancel.current?.focus();
  }, [confirmation]);
  const approve = async () => {
    if (
      !confirmation ||
      !confirmationCurrent ||
      unavailable ||
      pendingRef.current
    )
      return;
    pendingRef.current = true;
    setPending(true);
    setNotice("Recording approval…");
    try {
      const response = await fetch(
        `/api/work-items/${encodeURIComponent(confirmation.id)}/approve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(confirmation.approval),
        },
      );
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          result.error ?? "Approval failed. Refresh the Work Item.",
        );
      const approved = result as WorkItemView;
      setNotice(
        `Recorded ${confirmation.approval.gate} approval. Work Item is ${approved.decision.state}.`,
      );
      setConfirmation(undefined);
      await client.invalidateQueries({ queryKey: ["work-items"] });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
      await snapshot.refetch();
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  return (
    <section className={styles.content} aria-labelledby="work-items-heading">
      <h2 id="work-items-heading">Work Items</h2>
      <p className={styles.lead}>
        Inspect the contract before approving scope or design. The runner admits
        ready work on its next intake scan.
      </p>
      {snapshot.isPending && <p role="status">Loading Work Items…</p>}
      {snapshot.isError && (
        <div className={styles.warning} role="alert">
          <strong>
            {snapshot.data
              ? "Displayed Work Items are stale."
              : "Work Items unavailable."}
          </strong>
          <p>{snapshot.error.message}</p>
          <button type="button" onClick={() => void snapshot.refetch()}>
            Try again
          </button>
        </div>
      )}
      {!!items.length && (
        <label>
          Work Item
          <select
            value={selected?.work.id}
            disabled={pending}
            onChange={(event) => {
              setSelectedId(event.target.value);
              setConfirmation(undefined);
              setNotice("");
            }}
          >
            {items.map((item) => (
              <option key={item.work.id} value={item.work.id}>
                {item.work.contract.title} · Track {item.decision.track} ·{" "}
                {item.decision.state}
              </option>
            ))}
          </select>
        </label>
      )}
      {!snapshot.isPending && !snapshot.isError && !items.length && (
        <p className={styles.empty}>
          No Work Items for this project. Start work through the intake skill or
          CLI with SDLC enabled.
        </p>
      )}
      {selected && (
        <article className={styles.evidence} aria-label="Selected Work Item">
          <h3>{selected.work.contract.title}</h3>
          <p>{selected.work.contract.intent}</p>
          <dl className={styles.facts}>
            <div>
              <dt>Project</dt>
              <dd>{selected.work.projectId}</dd>
            </div>
            <div>
              <dt>Track and state</dt>
              <dd>
                Track {selected.decision.track} · {selected.decision.state}
              </dd>
            </div>
            <div>
              <dt>Contract revision</dt>
              <dd>
                <code>{selected.work.revision}</code>
              </dd>
            </div>
            <div>
              <dt>Work Item ID</dt>
              <dd>
                <code>{selected.work.id}</code>
              </dd>
            </div>
            <div>
              <dt>Execution attempts</dt>
              <dd>
                {selected.runIds.length ||
                  "None. Approval waiting does not create a Run."}
              </dd>
            </div>
          </dl>
          {!!selected.decision.reasons.length && (
            <ul>
              {selected.decision.reasons.map((reason) => (
                <li key={`${reason.code}-${reason.message}`}>
                  {reason.message}
                </li>
              ))}
            </ul>
          )}
          <h4>Acceptance criteria</h4>
          {selected.work.contract.acceptanceCriteria.length ? (
            <ul>
              {selected.work.contract.acceptanceCriteria.map((criterion) => (
                <li key={criterion}>{criterion}</li>
              ))}
            </ul>
          ) : (
            <p>Expected outcomes are not defined.</p>
          )}
          <h4>Complete contract</h4>
          <pre className={styles.diagnostic}>
            {JSON.stringify(selected.work.contract, null, 2)}
          </pre>
          {selected.approvalSource !== "local-operator" ? (
            <p className={styles.attention}>
              This project requires authenticated approval from an allowed human
              through {selected.approvalSource}. Local monitor actions cannot
              grant that approval.
            </p>
          ) : gate && !confirmation ? (
            <button
              type="button"
              disabled={unavailable}
              onClick={() =>
                setConfirmation({
                  id: selected.work.id,
                  title: selected.work.contract.title,
                  approval: { gate, revision: selected.work.revision },
                })
              }
            >
              Review {gate} approval
            </button>
          ) : null}
          {confirmation && (
            <section
              className={styles.attention}
              aria-label="Approval confirmation"
            >
              <h4>
                Approve {confirmation.approval.gate} for {confirmation.title}?
              </h4>
              <p>This authorizes the inspected contract revision.</p>
              <code>{confirmation.approval.revision}</code>
              {!confirmationCurrent && (
                <p role="alert">
                  The Work Item changed. Cancel and inspect the current
                  contract.
                </p>
              )}
              <div className={styles.toolbar}>
                <button
                  type="button"
                  ref={cancel}
                  disabled={pending}
                  onClick={() => setConfirmation(undefined)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={unavailable || !confirmationCurrent}
                  onClick={() => void approve()}
                >
                  Confirm {confirmation.approval.gate} approval
                </button>
              </div>
            </section>
          )}
          {!!selected.approvals.length && (
            <details>
              <summary>Approval history</summary>
              <pre className={styles.diagnostic}>
                {JSON.stringify(selected.approvals, null, 2)}
              </pre>
            </details>
          )}
        </article>
      )}
      <p role="status">{notice}</p>
    </section>
  );
}
