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
export interface ReviewRequest extends Issue {
  change: ChangeRequest;
  base: string;
  start: string;
  sourceBranch: string;
  targetBranch: string;
  draft: boolean;
  fork: boolean;
}
export type RunSubject =
  | (Issue & { kind: "issue" })
  | (ReviewRequest & { kind: "change-request" });
export function subjectReference(subject: RunSubject): string {
  return `${subject.kind === "change-request" ? "Review " : ""}#${subject.number}`;
}
export class StaleReviewError extends Error {
  constructor() {
    super("Review superseded: change request eligibility or revisions changed");
    this.name = "StaleReviewError";
  }
}
export const publicationSchema = z.strictObject({
  commitMessage: z.string().trim().min(1).max(10000),
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().min(1).max(60000),
});
export type Publication = z.infer<typeof publicationSchema>;
export const reviewSchema = z
  .strictObject({
    complete: z.boolean(),
    limitations: z.array(z.string().trim().min(1)),
    summary: z.string().min(1),
    findings: z.array(
      z.strictObject({
        body: z.string().min(1),
        path: z.string().nullable().default(null),
        line: z.number().int().positive().nullable().default(null),
      }),
    ),
  })
  .refine((review) => review.complete || review.limitations.length > 0, {
    message: "Incomplete review requires at least one inspection limitation",
    path: ["limitations"],
  });
export type Review = z.input<typeof reviewSchema>;
export interface ReviewPositions {
  inline: Array<{ body: string; path: string; oldPath: string; line: number }>;
  summaryFindings: string[];
}
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
  paths: string[];
  files: Record<string, string | null>;
}
export interface ContributionCandidate {
  provider: string;
  beforeFiles: Record<string, string | null>;
  afterFiles: Record<string, string | null>;
}
export interface Workspace {
  check(project: Project): Promise<void>;
  prepareReview(
    project: Project,
    request: ReviewRequest,
    signal?: AbortSignal,
  ): Promise<Snapshot>;
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
  listChanges(labels: string[]): Promise<ReviewRequest[]>;
  getChange(number: number): Promise<ReviewRequest>;
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
    positions: ReviewPositions;
    reviewTarget?: { request: ReviewRequest; labels: string[] };
  }): Promise<void>;
}
export interface AgentInvocation {
  id: string;
  runId: string;
  step: string;
  cwd: string;
  prompt: string;
  profile: AgentProfile;
  outputSchema?: unknown;
  processFile?: string;
  resumeSessionId?: string;
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
  | "ineligible"
  | "superseded";
export interface ExecutionRecord {
  /** DBOS workflow identity; review retries retain their original publication marker. */
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
  subject: RunSubject;
  validationProfile?: string;
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
  contributionCandidates?: ContributionCandidate[];
  contributingProviders?: string[];
  change?: ChangeRequest;
  review?: Review;
  reviewHead?: string;
  reviewPublicationId?: string;
  error?: string;
  failedStep?: number;
  stageLogs?: Array<{ executionId: string; step: string; path: string }>;
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
