import { execFileSync } from "node:child_process";
import type { Project } from "@mingchuno/agent-workflows-core";

/**
 * Personal projects may reuse the host CLI's sign-in. Provider approval
 * sources need an explicit opt-in because they rely on credential separation.
 */
export function cliTokenAllowed(project: Project): boolean {
  return (
    project.hosting.tokenFromCli ??
    project.sdlc.approvalSource === "local-operator"
  );
}

function cliToken(project: Project): string | undefined {
  const host = new URL(project.hosting.origin).host;
  const [executable, args] =
    project.hosting.provider === "github"
      ? ["gh", ["auth", "token", "--hostname", host]]
      : ["glab", ["config", "get", "token", "--host", host]];
  try {
    return (
      execFileSync(executable, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

export type TokenSource = "environment" | "gh" | "glab";
const filled = new Map<string, TokenSource>();

/**
 * Fill each missing hosting token from `gh` or `glab`. The value lands in the
 * project's `tokenEnv`, so existing redaction and subprocess filtering apply.
 */
export function applyCliTokens(
  projects: readonly Project[],
): Map<string, TokenSource> {
  const sources = new Map<string, TokenSource>();
  for (const project of projects) {
    const name = project.hosting.tokenEnv;
    if (process.env[name]) {
      sources.set(project.id, filled.get(name) ?? "environment");
      continue;
    }
    if (!cliTokenAllowed(project)) continue;
    const value = cliToken(project);
    if (!value) continue;
    process.env[name] = value;
    const source = project.hosting.provider === "github" ? "gh" : "glab";
    filled.set(name, source);
    sources.set(project.id, source);
  }
  return sources;
}
