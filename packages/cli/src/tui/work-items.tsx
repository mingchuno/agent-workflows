import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkApproval, WorkItemView } from "../web/contracts.js";
import { tuiRefreshIntervalMs } from "./constants.js";
import type { MonitorSource } from "./data.js";
import { ConfirmDialog } from "./dialogs.js";
import { chromeCells, wrapLines } from "./format.js";
import { Lines } from "./views.js";

export function WorkItemsView({
  source,
  projectId,
  columns,
  rows,
  onClose,
}: {
  source: MonitorSource;
  projectId?: string;
  columns: number;
  rows: number;
  onClose: () => void;
}) {
  const [items, setItems] = useState<WorkItemView[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [offset, setOffset] = useState(0);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState("Loading Work Items...");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [confirmation, setConfirmation] = useState<{
    id: string;
    title: string;
    approval: WorkApproval;
  }>();
  const refresh = useCallback(async () => {
    if (!source.workItems)
      throw new Error(
        "Work Item inspection is unavailable. Reconnect to the runner.",
      );
    return source.workItems();
  }, [source]);
  useEffect(() => {
    let closed = false;
    let busy = false;
    const update = async () => {
      if (busy) return;
      busy = true;
      try {
        const current = await refresh();
        if (closed) return;
        setItems(current);
        setConnected(true);
        setStatus("Ready work is admitted on the runner's next intake scan.");
      } catch (error) {
        if (!closed) {
          setConnected(false);
          setStatus(
            `Work Items unavailable. ${error instanceof Error ? error.message : String(error)}`,
          );
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
  }, [refresh]);
  const visible = items.filter(
    (item) => !projectId || item.work.projectId === projectId,
  );
  const selected =
    visible.find((item) => item.work.id === selectedId) ?? visible[0];
  const gate = selected?.decision.awaitingGate;
  const allowed =
    connected &&
    !pending &&
    selected?.approvalSource === "local-operator" &&
    Boolean(gate && source.approveWork);
  const height = rows - 8;
  const lines = selected
    ? [
        selected.work.contract.title,
        `Project ${selected.work.projectId} / Track ${selected.decision.track} / ${selected.decision.state}`,
        "",
        "Contract revision",
        selected.work.revision,
        "",
        ...selected.decision.reasons.map((reason) => reason.message),
        ...(selected.approvalSource !== "local-operator"
          ? [
              `Approval requires an authenticated allowed human through ${selected.approvalSource}.`,
            ]
          : []),
        "",
        "Complete contract",
        ...JSON.stringify(selected.work.contract, null, 2).split("\n"),
        "",
        `Recorded execution attempts: ${selected.runIds.length}`,
        "Approval history",
        ...JSON.stringify(selected.approvals, null, 2).split("\n"),
      ]
    : [
        connected
          ? "No Work Items for this project. Start work through the intake skill or CLI with SDLC enabled."
          : "Waiting for Work Item evidence.",
      ];
  const maximum = Math.max(0, wrapLines(lines, columns - 4).length - height);
  const currentOffset = Math.min(offset, maximum);
  useInput((input, key) => {
    if (key.ctrl || key.meta || key.eventType === "release" || confirmation)
      return;
    if (key.escape || input === "w" || input === "q") onClose();
    else if (key.tab && visible.length) {
      const index = visible.findIndex(
        (item) => item.work.id === selected?.work.id,
      );
      setSelectedId(
        visible[
          (index + (key.shift ? -1 : 1) + visible.length) % visible.length
        ]!.work.id,
      );
      setOffset(0);
      setMessage("");
    } else if (input === "a" && allowed && selected && gate)
      setConfirmation({
        id: selected.work.id,
        title: selected.work.contract.title,
        approval: { revision: selected.work.revision, gate },
      });
    else if (key.home) setOffset(0);
    else if (key.end) setOffset(maximum);
    else if (key.upArrow || key.pageUp)
      setOffset(Math.max(0, currentOffset - (key.pageUp ? height : 1)));
    else if (key.downArrow || key.pageDown)
      setOffset(Math.min(maximum, currentOffset + (key.pageDown ? height : 1)));
  });
  const approve = async () => {
    if (!confirmation || !source.approveWork || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setConfirmation(undefined);
    setMessage("Recording approval...");
    try {
      const result = await source.approveWork(
        confirmation.id,
        confirmation.approval,
      );
      setMessage(
        `Recorded ${confirmation.approval.gate} approval. Work Item is ${result.decision.state}.`,
      );
      setItems(await refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  if (confirmation)
    return (
      <ConfirmDialog
        columns={columns}
        rows={rows}
        title={`Approve ${confirmation.approval.gate}`}
        subject={confirmation.title}
        description={`Authorize this exact contract revision.\n\n${confirmation.approval.revision}`}
        available={
          allowed &&
          selected?.work.id === confirmation.id &&
          selected.work.revision === confirmation.approval.revision &&
          gate === confirmation.approval.gate
        }
        onCancel={() => setConfirmation(undefined)}
        onConfirm={() => void approve()}
      />
    );
  return (
    <Box width={columns} height={rows} paddingX={2} flexDirection="column">
      <Text bold>Work Items{projectId ? ` / ${projectId}` : ""}</Text>
      <Lines lines={[status]} width={columns - 4} height={2} />
      <Text>
        {chromeCells(
          `${visible.length ? visible.findIndex((item) => item.work.id === selected?.work.id) + 1 : 0}/${visible.length} Work Items / ${currentOffset + 1}/${maximum + 1} scroll positions`,
          columns - 4,
        )}
      </Text>
      <Lines
        lines={lines}
        width={columns - 4}
        height={height}
        offset={currentOffset}
      />
      <Text>{chromeCells(message, columns - 4)}</Text>
      <Text>
        {chromeCells(
          `${allowed ? `a approve ${gate} / ` : ""}Tab select / Up/Down scroll / PgUp/PgDn / Esc close`,
          columns - 4,
        )}
      </Text>
    </Box>
  );
}
