import { write as writeFileDescriptor } from "node:fs";
import type { Outcome, RunRecord } from "../domain.js";

const terminalOutcomes = [
  "completed",
  "failed",
  "blocked",
  "cancelled",
  "no-change",
  "ineligible",
] as const satisfies readonly Outcome[];
const terminalOutcomeSet = new Set<Outcome>(terminalOutcomes);
const whitespace = /\s+/gu;
const maximumPayloadBytes = 256;
const notificationPrefix = "agent-workflows: ";

export type TerminalOutcome = (typeof terminalOutcomes)[number];
export interface ExecutionNotification {
  project: string;
  issue: string;
  outcome: TerminalOutcome;
}
export interface ExecutionNotificationWriter {
  notify(notification: ExecutionNotification): void;
}

export class ExecutionNotificationObserver {
  private seeded = false;
  private readonly observedTerminalExecutionIds = new Set<string>();

  constructor(private readonly writer: ExecutionNotificationWriter) {}

  observe(runs: RunRecord[]) {
    for (const run of runs) {
      for (const execution of run.executions ?? []) {
        if (!this.seeded) {
          if (isTerminal(execution.outcome))
            this.observedTerminalExecutionIds.add(execution.id);
          continue;
        }
        if (
          this.observedTerminalExecutionIds.has(execution.id) ||
          !isTerminal(execution.outcome)
        )
          continue;
        this.observedTerminalExecutionIds.add(execution.id);
        try {
          this.writer.notify({
            project: run.projectId,
            issue: `#${run.issue.number}`,
            outcome: execution.outcome,
          });
        } catch {
          // Execution notifications are advisory and never affect monitoring.
        }
      }
    }
    this.seeded = true;
  }
}

export function createTerminalNotificationWriter({
  write = writeTerminal,
  tmux = Boolean(process.env.TMUX),
}: {
  write?: (value: string) => void | Promise<void>;
  tmux?: boolean;
} = {}): ExecutionNotificationWriter {
  return {
    notify(notification) {
      const suffix = ` · ${sanitize(notification.issue)} · ${notification.outcome}`;
      const projectBytes = Math.max(
        0,
        maximumPayloadBytes -
          Buffer.byteLength(notificationPrefix + suffix, "utf8"),
      );
      const message = `${notificationPrefix}${truncateUtf8(sanitize(notification.project), projectBytes)}${suffix}`;
      const osc = `\u001b]9;${message}\u001b\\`;
      const sequence = tmux
        ? `\u001bPtmux;${osc.replaceAll("\u001b", "\u001b\u001b")}\u001b\\`
        : osc;
      try {
        const pending = write(sequence);
        if (pending) void pending.catch(() => undefined);
      } catch {
        // Execution notifications are advisory and never affect monitoring.
      }
    },
  };
}

function isTerminal(outcome: Outcome): outcome is TerminalOutcome {
  return terminalOutcomeSet.has(outcome);
}

function sanitize(value: string) {
  return [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0)!;
      return !(codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f));
    })
    .join("")
    .replace(whitespace, " ")
    .trim();
}

function writeTerminal(value: string) {
  return new Promise<void>((resolve, reject) => {
    writeFileDescriptor(process.stdout.fd, value, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function truncateUtf8(value: string, maximumBytes: number) {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maximumBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}
