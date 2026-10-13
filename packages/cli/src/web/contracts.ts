import type {
  EventRecord,
  InvocationRecord,
  ProjectState,
  RunRecord,
  Store,
} from "@mingchuno/agent-workflows-core";
import { z } from "zod";

export const defaultWebPort = 8787;
export const monitorCommandSchema = z.strictObject({
  kind: z.enum([
    "pause",
    "resume",
    "stop",
    "retry",
    "retry-refresh",
    "recover",
    "reload",
  ]),
  target: z.string().max(256),
});
export type MonitorCommand = z.infer<typeof monitorCommandSchema>;
export interface MonitorSnapshot {
  projects: ProjectState[];
  runs: RunRecord[];
  commands: Awaited<ReturnType<Store["commands"]>>;
  visibleRunIds: string[];
}
export interface RecordedLog {
  id: string;
  label: string;
  executionId?: string;
}
export interface RunEvidence {
  run: RunRecord;
  sessions: InvocationRecord[];
  events: EventRecord[];
  logs: RecordedLog[];
  actionReasons: { stop?: string; retry?: string; recover?: string };
}
export interface LogPage {
  lines: string[];
  start: number;
  total: number;
  match?: number;
}
