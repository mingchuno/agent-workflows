import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Project, Stage } from "./config.js";

export const defaultStagePrompts = {
  implementation: `Implement the supplied issue in the current checkout. Follow repository
instructions and existing conventions. Keep changes focused on the issue's
requirements, and add or update tests where needed to verify the behavior.`,
  publication: `Prepare a Git commit message and a pull request or merge request title and
description for the supplied changes. Follow repository conventions. Describe
what changed and why, summarize the recorded validation accurately, and state
material limitations. Do not claim checks passed unless the supplied evidence
shows they ran and passed.`,
  review: `Independently review the supplied published changes against the issue's
requirements and repository conventions. Inspect the change artifacts and
relevant source for correctness, regressions, and missing validation. Report
actionable findings with supporting locations where possible. State any gaps
in inspection explicitly; do not present an incomplete review as a clean review.`,
} as const;
export interface ResolvedPrompt {
  source: "default" | "inline" | "file";
  path?: string;
  content: string;
  sha256: string;
}
export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
const overrides = new WeakMap<Stage, ResolvedPrompt>();
/** Resolve overrides once. Defaults belong to the caller, not the stage name. */
export function resolveStagePrompt(
  stage: Stage,
  defaultTask: string,
  baseDirectory?: string,
): ResolvedPrompt {
  const cached = overrides.get(stage);
  if (cached) return cached;
  if (stage.prompt !== undefined && stage.promptFile !== undefined)
    throw new Error("Specify either prompt or promptFile, never both");
  let content = stage.prompt ?? defaultTask;
  let path: string | undefined;
  if (stage.promptFile !== undefined) {
    if (!isAbsolute(stage.promptFile) && !baseDirectory)
      throw new Error(
        "Relative promptFile requires an explicit base directory",
      );
    path = resolve(baseDirectory ?? "/", stage.promptFile);
    try {
      content = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(readFileSync(path));
    } catch (cause) {
      throw new Error(`Cannot read UTF-8 promptFile ${path}`, { cause });
    }
  }
  if (!content.trim())
    throw new Error(`Stage prompt must be nonblank${path ? `: ${path}` : ""}`);
  const result: ResolvedPrompt = {
    source: path ? "file" : stage.prompt !== undefined ? "inline" : "default",
    ...(path ? { path } : {}),
    content,
    sha256: sha256(content),
  };
  if (result.source === "file") overrides.set(stage, result);
  return result;
}
export function projectPrompts(project: Project, baseDirectory?: string) {
  return Object.fromEntries(
    Object.entries(defaultStagePrompts).map(([name, task]) => [
      name,
      resolveStagePrompt(
        project.stages[name as keyof typeof defaultStagePrompts],
        task,
        baseDirectory,
      ),
    ]),
  );
}
