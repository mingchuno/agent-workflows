import { command } from "../runtime/process.js";
import { assessReadiness, reassessChanges } from "./policy.js";
import type {
  DecisionReason,
  SdlcPolicy,
  Track,
  WorkContract,
} from "./schema.js";

export interface WorkClassification {
  track: Track;
  /** inline: the interactive session executes; delegated: the runner does. */
  protocol: "inline" | "delegated";
  trackReasons: string[];
  missing: DecisionReason[];
  changedPaths?: string[];
  escalation?: DecisionReason[];
}

/**
 * Classify work without persistence. Track A runs inline in the interactive
 * session; Tracks B and C need recorded approval and delegate to the runner.
 */
export function classifyWork(
  contract: WorkContract,
  policy: SdlcPolicy,
  changedPaths?: string[],
): WorkClassification {
  const decision = assessReadiness(contract, [], policy);
  const classification: WorkClassification = {
    track: decision.track,
    protocol: decision.track === "A" ? "inline" : "delegated",
    trackReasons: decision.trackReasons,
    missing: decision.reasons.filter((reason) => reason.code !== "approval"),
  };
  if (changedPaths === undefined) return classification;
  return {
    ...classification,
    changedPaths,
    escalation: reassessChanges(contract, decision.track, policy, changedPaths),
  };
}

/** Repository-relative paths changed since `base`, including untracked files. */
export async function changedPathsSince(
  checkout: string,
  base: string,
): Promise<string[]> {
  const git = async (args: string[]) =>
    (await command("git", args, { cwd: checkout })).stdout;
  const revision = (
    await git(["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`])
  ).trim();
  const listed = [
    await git(["diff", "--name-only", "-z", "--no-renames", revision, "--"]),
    await git(["ls-files", "--others", "--exclude-standard", "-z"]),
  ].flatMap((output) => output.split("\0").filter(Boolean));
  return [...new Set(listed)].sort();
}
