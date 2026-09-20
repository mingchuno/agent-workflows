import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import type { Project } from "./config.js";
import {
  BlockedError,
  type HostingAdapter,
  type RunRecord,
  type Workspace,
} from "./domain.js";
import { verifyEvidence } from "./evidence.js";
import { projectPrompts } from "./prompts.js";
import { assertProcessesStopped } from "./runtime/ownership.js";
import { command } from "./runtime/process.js";
import type { Store } from "./store.js";

export const publicationSteps: readonly string[] = [
  "push",
  "change-request",
  "review-publication",
];

export function recoveryUnavailable(run: RunRecord): string | undefined {
  if (run.outcome !== "failed")
    return "Only failed publication runs can be recovered";
  if (!publicationSteps.includes(run.phase))
    return `Recovery does not support ${run.phase}`;
  const execution = run.executions?.at(-1);
  if (!execution?.fingerprint || execution.failedStep === undefined)
    return "Run has no recovery metadata; use retry for a fresh attempt";
  if (!execution.recoverySupported)
    return "Publication recovery supports the default workflow only";
  if (!run.head || !run.base || !run.snapshot || !run.publication)
    return "Missing committed publication evidence";
  if (
    run.phase === "review-publication" &&
    (!run.change || !run.review || run.reviewHead !== run.head)
  )
    return "Missing review for the published revision";
  return undefined;
}

/** Hash execution inputs without reading credential environment values. */
export async function executionFingerprint(
  project: Project,
  workflowVersion: string,
  signal?: AbortSignal,
): Promise<string> {
  const {
    pollIntervalMs: _poll,
    labels: _labels,
    branchTemplate: _branch,
    hosting,
    ...execution
  } = project;
  const { tokenEnv: _token, ...destination } = hosting;
  const prompts = projectPrompts(project);
  const remote = await command(
    "git",
    ["remote", "get-url", "--push", "--all", project.remote],
    { cwd: project.checkout, signal },
  );
  const fetchRemote = await command(
    "git",
    ["remote", "get-url", "--all", project.remote],
    { cwd: project.checkout, signal },
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 2,
        workflowVersion,
        execution,
        destination,
        prompts,
        remote: remote.stdout,
        fetchRemote: fetchRemote.stdout,
      }),
    )
    .digest("hex");
}

interface RecoveryDependencies {
  project: Project;
  workspace: Workspace;
  hosting: HostingAdapter;
  store: Pick<Store, "invocations">;
  stateDirectory: string;
  workflowVersion: string;
  signal?: AbortSignal;
}

/** Read-only checks shared by admission and the first non-replayed operation. */
export async function verifyPublicationRecovery(
  run: RunRecord,
  dependencies: RecoveryDependencies,
): Promise<void> {
  const {
    project,
    workspace,
    hosting,
    store,
    stateDirectory,
    workflowVersion,
    signal,
  } = dependencies;
  if (run.checkout !== project.checkout)
    throw new BlockedError(
      "Configured checkout differs from the recorded run checkout",
    );
  const fingerprint = await executionFingerprint(
    project,
    workflowVersion,
    signal,
  );
  if (fingerprint !== run.executions?.at(-1)?.fingerprint)
    throw new BlockedError(
      "Execution configuration or prompts changed; use retry",
    );
  await assertProcessesStopped(resolve(stateDirectory, run.id));
  const gitDirectory = (
    await command("git", ["rev-parse", "--absolute-git-dir"], {
      cwd: project.checkout,
      signal,
    })
  ).stdout.trim();
  await assertProcessesStopped(
    resolve(gitDirectory, "agent-workflows-processes"),
  );
  await workspace.check(project);
  const snapshot = await workspace.inspect(project);
  if (snapshot.branch !== run.branch || snapshot.head !== run.head)
    throw new BlockedError("Recovery requires the original branch and commit");
  await workspace.verify(project, run.snapshot!);
  await command("git", ["cat-file", "-e", `${run.base}^{commit}`], {
    cwd: project.checkout,
    signal,
  });
  const invocations = await store.invocations(run.id);
  for (const invocation of invocations) {
    if (invocation.evidence) await verifyEvidence(invocation.evidence);
  }
  for (const path of [
    ...invocations.map((item) => item.log),
    ...(run.validation ?? []).map((item) => item.log),
  ]) {
    try {
      await access(path);
    } catch {
      throw new BlockedError(`Recovery artifact unavailable: ${path}`);
    }
  }
  const remote = (
    await command(
      "git",
      ["ls-remote", "--heads", project.remote, `refs/heads/${run.branch}`],
      { cwd: project.checkout, signal },
    )
  ).stdout.trim();
  if (
    (remote && remote.split(/\s/)[0] !== run.head) ||
    (!remote && run.phase !== "push")
  )
    throw new BlockedError(
      "Published remote revision changed; recovery refused",
    );
  const change = await hosting.findChange(run.branch);
  if (change && change.head !== run.head)
    throw new BlockedError("Existing change request has a different head");
  if (
    run.phase === "review-publication" &&
    (!run.change || (await hosting.head(run.change)) !== run.reviewHead)
  )
    throw new BlockedError("Review stale: remote head changed");
}
