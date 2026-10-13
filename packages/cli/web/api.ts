import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MonitorCommand, MonitorSnapshot } from "../src/web/contracts.js";
import {
  type CommandEvent,
  type CommandLifecycle,
  commandNotice,
  commandPending,
  transitionCommand,
} from "./command-lifecycle.js";

export async function readMonitor<T>(
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, { signal });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(
      body?.error ?? `Monitor request failed (${response.status}). Try again.`,
    );
  }
  return response.json();
}

export async function submitMonitorCommand(
  command: MonitorCommand,
): Promise<{ id: string }> {
  const response = await fetch("/api/commands", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error ?? "Command submission failed");
  return result;
}

export function useOperatorCommands(snapshot?: MonitorSnapshot) {
  const client = useQueryClient();
  const [state, setState] = useState<CommandLifecycle>({ phase: "idle" });
  // Advance synchronously so two submissions in the same render cannot race.
  const currentState = useRef(state);
  const transition = useCallback((event: CommandEvent) => {
    const next = transitionCommand(currentState.current, event);
    currentState.current = next;
    setState(next);
  }, []);
  const mutation = useMutation({
    mutationFn: submitMonitorCommand,
    onSuccess: ({ id }) => {
      transition({ type: "accepted", id });
      void client.invalidateQueries({ queryKey: ["snapshot"] });
    },
    onError: (error) => transition({ type: "failed", message: error.message }),
  });
  useEffect(() => {
    if (state.phase !== "awaiting") return;
    const command = snapshot?.commands.find(
      (command) => command.id === state.pendingCommandId,
    );
    if (!command || command.status === "pending") return;
    transition({ type: "acknowledged", command });
    void client.invalidateQueries({ queryKey: ["evidence"] });
  }, [snapshot, state, client, transition]);
  return {
    pending: commandPending(state),
    notice: commandNotice(state),
    submit(command: MonitorCommand) {
      if (commandPending(currentState.current)) return;
      transition({ type: "submit", kind: command.kind });
      mutation.mutate(command);
    },
  };
}
