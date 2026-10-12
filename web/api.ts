import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { MonitorCommand, MonitorSnapshot } from "../src/web/contracts.js";

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

export function useOperatorCommands(snapshot?: MonitorSnapshot) {
  const client = useQueryClient();
  const [pending, setPending] = useState<string>();
  const [notice, setNotice] = useState("");
  const submitting = useRef(false);
  const mutation = useMutation({
    mutationFn: async (command: MonitorCommand) => {
      const response = await fetch("/api/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error ?? "Command submission failed");
      return result as { id: string };
    },
    onSuccess: ({ id }) => {
      setPending(id);
      void client.invalidateQueries({ queryKey: ["snapshot"] });
    },
    onError: (error) => {
      setNotice(
        `Submission failed: ${error.message}. Check status before trying again.`,
      );
      submitting.current = false;
    },
  });
  useEffect(() => {
    const command = snapshot?.commands.find(
      (command) => command.id === pending,
    );
    if (!command || command.status === "pending") return;
    setNotice(
      `${command.kind}: ${command.status}${command.error ? ` — ${command.error}` : ""}`,
    );
    setPending(undefined);
    submitting.current = false;
    void client.invalidateQueries({ queryKey: ["evidence"] });
  }, [snapshot, pending, client]);
  return {
    pending: mutation.isPending || !!pending,
    notice,
    submit(command: MonitorCommand) {
      if (submitting.current) return;
      submitting.current = true;
      setNotice(
        `${command.kind}: pending — waiting for runner acknowledgement`,
      );
      mutation.mutate(command);
    },
  };
}
