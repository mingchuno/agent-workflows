import type { Outcome, RunRecord } from "../domain.js";

const terminalOutcomes = new Set<Outcome>([
  "completed",
  "failed",
  "blocked",
  "cancelled",
  "no-change",
  "ineligible",
]);
const whitespace = /\s+/gu;
const maximumPayloadBytes = 256;

export type TerminalOutcome = Exclude<Outcome, "queued" | "running">;
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
  private readonly outcomes = new Map<string, Outcome>();
  private readonly handled = new Set<string>();

  constructor(private readonly writer: ExecutionNotificationWriter) {}

  observe(runs: RunRecord[]) {
    for (const run of runs) {
      for (const execution of run.executions ?? []) {
        const previous = this.outcomes.get(execution.id);
        this.outcomes.set(execution.id, execution.outcome);
        if (!this.seeded) {
          if (isTerminal(execution.outcome)) this.handled.add(execution.id);
          continue;
        }
        if (
          this.handled.has(execution.id) ||
          !isTerminal(execution.outcome) ||
          (previous !== undefined && isTerminal(previous))
        )
          continue;
        this.handled.add(execution.id);
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
  write = (value) => {
    process.stdout.write(value);
  },
  tmux = Boolean(process.env.TMUX),
}: {
  write?: (value: string) => unknown;
  tmux?: boolean;
} = {}): ExecutionNotificationWriter {
  return {
    notify(notification) {
      const message = truncateUtf8(
        `agent-workflows: ${sanitize(notification.project)} · ${sanitize(notification.issue)} · ${notification.outcome}`,
        maximumPayloadBytes,
      );
      const osc = `\u001b]9;${message}\u001b\\`;
      write(
        tmux
          ? `\u001bPtmux;${osc.replaceAll("\u001b", "\u001b\u001b")}\u001b\\`
          : osc,
      );
    },
  };
}

function isTerminal(outcome: Outcome): outcome is TerminalOutcome {
  return terminalOutcomes.has(outcome);
}

function sanitize(value: string) {
  return [...value.replace(whitespace, " ")]
    .filter((character) => {
      const codePoint = character.codePointAt(0)!;
      return !(codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f));
    })
    .join("")
    .trim();
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
