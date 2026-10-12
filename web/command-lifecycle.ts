import type { MonitorCommand, MonitorSnapshot } from "../src/web/contracts.js";

type RecordedCommand = MonitorSnapshot["commands"][number];
export type CommandLifecycle =
  | { phase: "idle" }
  | { phase: "submitting"; kind: MonitorCommand["kind"] }
  | {
      phase: "awaiting";
      kind: MonitorCommand["kind"];
      pendingCommandId: string;
    }
  | { phase: "settled"; command: RecordedCommand }
  | { phase: "failed"; message: string };
export type CommandEvent =
  | { type: "submit"; kind: MonitorCommand["kind"] }
  | { type: "accepted"; id: string }
  | { type: "failed"; message: string }
  | { type: "acknowledged"; command: RecordedCommand };

export function commandPending(state: CommandLifecycle) {
  return state.phase === "submitting" || state.phase === "awaiting";
}

export function transitionCommand(
  state: CommandLifecycle,
  event: CommandEvent,
): CommandLifecycle {
  switch (event.type) {
    case "submit":
      return commandPending(state)
        ? state
        : { phase: "submitting", kind: event.kind };
    case "accepted":
      return state.phase === "submitting"
        ? { phase: "awaiting", kind: state.kind, pendingCommandId: event.id }
        : state;
    case "failed":
      return state.phase === "submitting"
        ? { phase: "failed", message: event.message }
        : state;
    case "acknowledged":
      return state.phase === "awaiting" &&
        event.command.id === state.pendingCommandId &&
        event.command.status !== "pending"
        ? { phase: "settled", command: event.command }
        : state;
  }
}

export function commandNotice(state: CommandLifecycle): string {
  switch (state.phase) {
    case "idle":
      return "";
    case "submitting":
    case "awaiting":
      return `${state.kind}: pending — waiting for runner acknowledgement`;
    case "failed":
      return `Submission failed: ${state.message}. Check status before trying again.`;
    case "settled": {
      const { command } = state;
      return `${command.kind}: ${command.status}${command.error ? ` — ${command.error}` : ""}`;
    }
  }
}
