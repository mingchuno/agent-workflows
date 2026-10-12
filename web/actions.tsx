import { useEffect, useId, useRef, useState } from "react";
import type { MonitorCommand, RunEvidence } from "../src/web/contracts.js";
import styles from "./app.module.css";

const actions = [
  {
    kind: "stop",
    label: "Stop run",
    description: "Cancel this run and wait for its active local work to stop.",
  },
  {
    kind: "retry",
    label: "Retry run",
    description: "Create a new run and branch using the saved task.",
  },
  {
    kind: "retry-refresh",
    label: "Retry with refreshed issue",
    description:
      "Create a new run using the current hosted issue and validation selection.",
  },
  {
    kind: "recover",
    label: "Recover publication",
    description:
      "Continue the failed publication step in this run, reusing completed checkpoints.",
  },
] as const;

export function Actions({
  evidence,
  disabled,
  submit,
}: {
  evidence: RunEvidence;
  disabled: boolean;
  submit: (command: MonitorCommand) => void;
}) {
  const [confirming, setConfirming] = useState<(typeof actions)[number]>();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const reason = (kind: (typeof actions)[number]["kind"]) =>
    disabled
      ? "Waiting for a fresh snapshot or pending command acknowledgement."
      : evidence.actionReasons[kind === "retry-refresh" ? "retry" : kind];
  useEffect(() => {
    if (confirming) {
      dialog.current?.showModal();
      cancel.current?.focus();
    } else dialog.current?.close();
  }, [confirming]);
  return (
    <>
      <h3>Operator actions</h3>
      <p className={styles.lead}>
        Recovery continues this run. Retry creates a new run and branch. The
        runner checks admission before acting.
      </p>
      <div className={styles.actionList}>
        {actions
          .filter(
            (action) =>
              action.kind !== "retry-refresh" ||
              evidence.run.subject.kind === "issue",
          )
          .map((action) => (
            <section key={action.kind}>
              <button
                type="button"
                disabled={!!reason(action.kind)}
                onClick={() => setConfirming(action)}
              >
                {action.label}
              </button>
              <p>{action.description}</p>
              {reason(action.kind) && (
                <p className={styles.muted}>
                  Unavailable: {reason(action.kind)}
                </p>
              )}
            </section>
          ))}
      </div>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className={styles.dialog}
        onCancel={() => setConfirming(undefined)}
        onClose={() => setConfirming(undefined)}
      >
        <h2 id={titleId}>{confirming?.label}?</h2>
        <p>{evidence.run.subject.title}</p>
        <p id={descriptionId}>{confirming?.description}</p>
        <div className={styles.toolbar}>
          <button
            ref={cancel}
            type="button"
            onClick={() => setConfirming(undefined)}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!confirming || !!reason(confirming.kind)}
            onClick={() => {
              if (!confirming || reason(confirming.kind)) return;
              submit({ kind: confirming.kind, target: evidence.run.id });
              setConfirming(undefined);
            }}
          >
            {confirming?.label ?? "Confirm"}
          </button>
        </div>
      </dialog>
    </>
  );
}
