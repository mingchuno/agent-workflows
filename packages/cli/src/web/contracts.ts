import type {
  EventRecord,
  InvocationRecord,
  ProjectState,
  RunRecord,
  Store,
  WorkItemView,
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
export const workApprovalSchema = z.strictObject({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  gate: z.enum(["scope", "design"]),
});
export type WorkApproval = z.infer<typeof workApprovalSchema>;
export const workResubmissionSchema = workApprovalSchema.pick({
  revision: true,
});
export type { WorkItemView };
export interface WorkItemsSnapshot {
  items: WorkItemView[];
}
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
