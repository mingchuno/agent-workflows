import { z } from "zod";

const text = z.string().trim().min(1);
const texts = z.array(text);
export const trackSchema = z.enum(["A", "B", "C"]);
export type Track = z.infer<typeof trackSchema>;
export const gateSchema = z.enum(["scope", "design"]);
export type ApprovalGate = z.infer<typeof gateSchema>;
export const repositoryPathSchema = text.refine(
  (path) =>
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").some((part) => part === ".." || part === "." || !part),
  "Use a repository-relative path without traversal",
);
export const assessmentSchema = z.strictObject({
  proposedTrack: trackSchema.optional(),
  complexity: z.enum(["small", "moderate", "large"]).default("moderate"),
  riskFlags: z
    .array(
      z.enum([
        "security",
        "migration",
        "breaking-api",
        "production",
        "sensitive-data",
        "cross-service",
        "irreversible",
      ]),
    )
    .default([]),
  uncertainties: texts.default([]),
  reasons: texts.default([]),
  paths: z.array(repositoryPathSchema).default([]),
});
export type Assessment = z.infer<typeof assessmentSchema>;
export const designSchema = z.strictObject({
  summary: text,
  alternatives: texts.default([]),
  stages: texts.min(1),
  verification: text,
  rollback: text,
  references: texts.default([]),
});
export const workContractSchema = z.strictObject({
  sourceRevision: text.optional(),
  title: text.max(240),
  /** Background, findings with sources, and decisions from clarification. */
  context: text.optional(),
  intent: text,
  acceptanceCriteria: texts.default([]),
  constraints: texts.default([]),
  assumptions: texts.default([]),
  scopePaths: z.array(repositoryPathSchema).default([]),
  references: texts.default([]),
  assessment: assessmentSchema.prefault({}),
  verification: z
    .strictObject({
      profile: text.regex(/^[a-zA-Z0-9_-]+$/).optional(),
      strategy: z.string().trim().default(""),
      manualChecks: texts.default([]),
    })
    .prefault({}),
  design: designSchema.optional(),
});
export type WorkContract = z.infer<typeof workContractSchema>;
const hostedSource = {
  issueId: text,
  number: z.number().int().positive(),
  url: z.url(),
  revision: text,
};
export const workSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("local"), key: text }),
  z.strictObject({ kind: z.literal("github"), ...hostedSource }),
  z.strictObject({ kind: z.literal("gitlab"), ...hostedSource }),
]);
export type WorkSource = z.infer<typeof workSourceSchema>;
export const workItemSchema = z.strictObject({
  id: text,
  projectId: text,
  source: workSourceSchema,
  contract: workContractSchema,
  revision: text.regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type WorkItem = z.infer<typeof workItemSchema>;
export const approvalRecordSchema = z.strictObject({
  id: text,
  workItemId: text,
  gate: gateSchema,
  revision: text.regex(/^[a-f0-9]{64}$/),
  approvedBy: text,
  approvedAt: z.iso.datetime(),
  source: z.enum(["local-operator", "github", "gitlab"]),
  evidence: z.url().optional(),
});
export type ApprovalRecord = z.infer<typeof approvalRecordSchema>;
export const sdlcPolicySchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    defaultTrack: trackSchema.default("B"),
    allowLocalTasks: z.boolean().default(true),
    approvalSource: z
      .enum(["local-operator", "github", "gitlab"])
      .default("local-operator"),
    approvers: texts.default([]),
    fastTrackMaxFiles: z.number().int().positive().default(10),
    riskRules: z
      .array(
        z.strictObject({
          paths: z.array(repositoryPathSchema).min(1),
          minimumTrack: trackSchema,
          validationProfile: text.regex(/^[a-zA-Z0-9_-]+$/).optional(),
        }),
      )
      .default([]),
  })
  .refine(
    (policy) =>
      policy.approvalSource === "local-operator" || policy.approvers.length > 0,
    {
      path: ["approvers"],
      message:
        "Provider approvals require an explicit human approver allowlist",
    },
  );
export type SdlcPolicy = z.infer<typeof sdlcPolicySchema>;
export interface DecisionReason {
  code:
    | "expected-outcome"
    | "uncertainty"
    | "scope"
    | "verification"
    | "approval"
    | "design"
    | "track-escalation"
    | "scope-expansion"
    | "source-changed";
  message: string;
}
export interface WorkDecision {
  track: Track;
  state:
    | "needs-info"
    | "awaiting-scope-approval"
    | "design"
    | "awaiting-design-approval"
    | "ready";
  reasons: DecisionReason[];
  trackReasons: string[];
  requiredGates: ApprovalGate[];
  /** The gate a human may approve now; set only in an awaiting-approval state. */
  awaitingGate?: ApprovalGate;
}
export interface WorkExecution {
  workItemId: string;
  revision: string;
  track: Track;
  contract: WorkContract;
  source: WorkSource;
  changedPaths?: string[];
}
