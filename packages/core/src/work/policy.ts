import { createHash } from "node:crypto";
import { matchesGlob } from "node:path";
import type {
  ApprovalGate,
  ApprovalRecord,
  DecisionReason,
  SdlcPolicy,
  Track,
  WorkContract,
  WorkDecision,
  WorkSource,
} from "./schema.js";

const rank: Record<Track, number> = { A: 0, B: 1, C: 2 };
export function maxTrack(left: Track, right: Track): Track {
  return rank[left] >= rank[right] ? left : right;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}
export function contentRevision(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export function contractRevision(contract: WorkContract): string {
  return contentRevision(contract);
}
export function workRevision(
  contract: WorkContract,
  source: WorkSource,
): string {
  return contentRevision({ contract, source });
}
export function gateRevision(
  contract: WorkContract,
  gate: ApprovalGate,
): string {
  const { design: _design, ...scope } = contract;
  return contentRevision(gate === "scope" ? scope : contract);
}
export function matchesPath(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesGlob(path, pattern));
}
function scopesMayOverlap(left: string, right: string): boolean {
  const prefix = (pattern: string) => {
    const segments = pattern.split("/");
    const wildcard = segments.findIndex((segment) =>
      /[*?[\]{}()!+@]/.test(segment),
    );
    return segments
      .slice(0, wildcard < 0 ? segments.length : wildcard)
      .join("/");
  };
  const a = prefix(left);
  const b = prefix(right);
  return !a || !b || a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}
export function resolveTrack(
  contract: WorkContract,
  policy: SdlcPolicy,
  actualPaths: string[] = [],
): { track: Track; reasons: string[] } {
  const assessment = contract.assessment;
  let track = assessment.proposedTrack ?? policy.defaultTrack;
  const reasons = [...assessment.reasons];
  if (assessment.complexity !== "small" || assessment.uncertainties.length) {
    track = maxTrack(track, "B");
    reasons.push(
      "Complexity or unresolved requirements require at least Track B",
    );
  }
  if (assessment.complexity === "large" || assessment.riskFlags.length) {
    track = "C";
    reasons.push(
      ...assessment.riskFlags.map((flag) => `Declared risk: ${flag}`),
    );
  }
  const declaredPaths = [...assessment.paths, ...contract.scopePaths];
  for (const rule of policy.riskRules) {
    if (
      !actualPaths.some((path) => matchesPath(path, rule.paths)) &&
      !declaredPaths.some((scope) =>
        rule.paths.some((protectedScope) =>
          scopesMayOverlap(scope, protectedScope),
        ),
      )
    )
      continue;
    track = maxTrack(track, rule.minimumTrack);
    reasons.push(`Protected path requires Track ${rule.minimumTrack}`);
  }
  return { track, reasons };
}
export function assessReadiness(
  contract: WorkContract,
  approvals: ApprovalRecord[],
  policy: SdlcPolicy,
): WorkDecision {
  const { track } = resolveTrack(contract, policy);
  const requiredGates: ApprovalGate[] =
    track === "A" ? [] : track === "B" ? ["scope"] : ["scope", "design"];
  const reasons: DecisionReason[] = [];
  if (!contract.acceptanceCriteria.length)
    reasons.push({
      code: "expected-outcome",
      message:
        "At least one expected outcome or reproducible failure is required",
    });
  for (const uncertainty of contract.assessment.uncertainties)
    reasons.push({ code: "uncertainty", message: uncertainty });
  if (track !== "A") {
    if (!contract.scopePaths.length)
      reasons.push({
        code: "scope",
        message: "Approved repository path boundaries are required",
      });
    if (!contract.verification.strategy)
      reasons.push({
        code: "verification",
        message: "A verification strategy is required",
      });
  }
  const result = (state: WorkDecision["state"]): WorkDecision => ({
    track,
    state,
    reasons,
    requiredGates,
  });
  if (reasons.length) return result("needs-info");
  for (const gate of requiredGates) {
    if (gate === "design" && !contract.design) {
      reasons.push({
        code: "design",
        message:
          "Technical design, staged plan, verification and rollback are required",
      });
      return result("design");
    }
    const valid = approvals.some(
      (approval) =>
        approval.gate === gate &&
        approval.revision === gateRevision(contract, gate) &&
        approval.source === policy.approvalSource &&
        (!policy.approvers.length ||
          policy.approvers.includes(approval.approvedBy)),
    );
    if (!valid) {
      reasons.push({
        code: "approval",
        message: `Current ${gate} approval is required`,
      });
      return result(
        gate === "scope"
          ? "awaiting-scope-approval"
          : "awaiting-design-approval",
      );
    }
  }
  return result("ready");
}
export function reassessChanges(
  contract: WorkContract,
  admittedTrack: Track,
  policy: SdlcPolicy,
  paths: string[],
): DecisionReason[] {
  const reasons: DecisionReason[] = [];
  const { track } = resolveTrack(contract, policy, paths);
  if (rank[track] > rank[admittedTrack])
    reasons.push({
      code: "track-escalation",
      message: `Actual changes require Track ${track}; admitted as ${admittedTrack}`,
    });
  if (contract.scopePaths.length) {
    for (const path of paths) {
      if (!matchesPath(path, contract.scopePaths))
        reasons.push({
          code: "scope-expansion",
          message: `Changed path is outside approved scope: ${path}`,
        });
    }
  }
  return reasons;
}
