import { z } from "zod";
import type { AgentProfile, Project } from "./config.js";

export interface Issue {
  id: string;
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  open: boolean;
}
export interface ChangeRequest {
  id: number;
  url: string;
  head: string;
}
export const publicationSchema = z.strictObject({
  commitMessage: z.string().trim().min(1).max(10000),
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().min(1).max(60000),
});
export type Publication = z.infer<typeof publicationSchema>;
export const reviewSchema = z.strictObject({
  summary: z.string().min(1),
  findings: z.array(
    z.strictObject({
      body: z.string().min(1),
      path: z.string().optional(),
      line: z.number().int().positive().optional(),
    }),
  ),
});
export type Review = z.infer<typeof reviewSchema>;
export interface ValidationResult {
  command: string;
  args: string[];
  exitCode: number;
  log: string;
  startedAt: string;
  finishedAt: string;
}
export interface Snapshot {
  branch: string;
  head: string;
  fingerprint: string;
  diff: string;
  paths: string[];
  files: Record<string, string | null>;
}
export interface Workspace {
  check(project: Project): Promise<void>;
  prepare(
    project: Project,
    branch: string,
    signal?: AbortSignal,
  ): Promise<Snapshot>;
  inspect(project: Project): Promise<Snapshot>;
  verify(project: Project, expected: Snapshot): Promise<void>;
  commit(
    project: Project,
    expected: Snapshot,
    publication: Publication,
    runId: string,
    signal?: AbortSignal,
  ): Promise<string>;
  push(
    project: Project,
    branch: string,
    head: string,
    signal?: AbortSignal,
  ): Promise<void>;
  release(project: Project): Promise<void>;
}
export interface HostingAdapter {
  identity: string;
  preflight?(): Promise<void>;
  listIssues(labels: string[]): Promise<Issue[]>;
  getIssue(number: number): Promise<Issue>;
  findChange(branch: string): Promise<ChangeRequest | undefined>;
  createChange(input: {
    branch: string;
    base: string;
    head: string;
    issue: Issue;
    publication: Publication;
    runId: string;
  }): Promise<ChangeRequest>;
  head(change: ChangeRequest): Promise<string>;
  publishReview(input: {
    change: ChangeRequest;
    head: string;
    review: Review;
    runId: string;
    diff: string;
  }): Promise<void>;
}
export interface AgentInvocation {
  id: string;
  runId: string;
  step: string;
  cwd: string;
  prompt: string;
  profile: AgentProfile;
  skills: string[];
  processFile?: string;
  readOnly: boolean;
  signal: AbortSignal;
  timeoutMs?: number;
  session: (id: string) => Promise<void>;
  event: (event: unknown) => Promise<void>;
}
export interface EffectiveProfile {
  provider: string;
  model: string;
  reasoningEffort: string;
  context: AgentProfile["context"] | "unknown";
  contextWindowTokens: number | "unknown";
}
export interface AgentAdapter {
  validate(
    profile: AgentProfile,
    signal?: AbortSignal,
  ): Promise<EffectiveProfile>;
  invoke(invocation: AgentInvocation): Promise<string>;
}
export type Outcome =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled"
  | "no-change"
  | "ineligible";
export interface ExecutionRecord {
  /** DBOS workflow identity; publication markers continue to use the run ID. */
  id: string;
  recoveryOf?: string;
  startStep?: number;
  reusedSteps?: string[];
  fingerprint: string;
  recoverySupported: boolean;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  outcome: Outcome;
  phase: string;
  failedStep?: number;
  error?: string;
}
export interface RunRecord {
  id: string;
  projectId: string;
  checkout: string;
  taskKey: string;
  attempt: number;
  retryOf?: string;
  issue: Issue;
  outcome: Outcome;
  phase: string;
  createdAt: string;
  updatedAt: string;
  branch: string;
  base?: string;
  head?: string;
  snapshot?: Snapshot;
  validation?: ValidationResult[];
  publication?: Publication;
  change?: ChangeRequest;
  review?: Review;
  reviewHead?: string;
  error?: string;
  failedStep?: number;
  executions?: ExecutionRecord[];
}
export class BlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedError";
  }
}
export function isBlockedError(error: unknown): error is BlockedError {
  return (
    error instanceof BlockedError ||
    (error instanceof Error && error.name === "BlockedError")
  );
}
