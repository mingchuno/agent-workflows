import { createHash, randomUUID } from "node:crypto";
import { access, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { Project } from "./config.js";
import {
  BlockedError,
  type Publication,
  type Snapshot,
  type Workspace,
} from "./domain.js";
import { type CommandOptions, command } from "./runtime/process.js";

export class ExistingCheckout implements Workspace {
  private readonly processDirectories = new Map<string, Promise<string>>();
  private processDirectory(project: Project): Promise<string> {
    let directory = this.processDirectories.get(project.checkout);
    if (!directory) {
      directory = (async () => {
        const result = await command(
          "git",
          ["rev-parse", "--absolute-git-dir"],
          {
            cwd: project.checkout,
          },
        );
        const path = join(result.stdout.trim(), "agent-workflows-processes");
        await mkdir(path, { recursive: true, mode: 0o700 });
        return path;
      })();
      this.processDirectories.set(project.checkout, directory);
    }
    return directory;
  }
  private async runGit(
    project: Project,
    args: string[],
    options: Pick<CommandOptions, "signal" | "allowFailure"> = {},
  ) {
    const directory = await this.processDirectory(project);
    return command("git", args, {
      ...options,
      cwd: project.checkout,
      processFile: join(directory, `${randomUUID()}.process.json`),
    });
  }
  private async git(project: Project, ...args: string[]) {
    return (await this.runGit(project, args)).stdout.trimEnd();
  }
  async check(project: Project): Promise<void> {
    const top = await this.git(project, "rev-parse", "--show-toplevel");
    if ((await realpath(top)) !== (await realpath(project.checkout)))
      throw new BlockedError("Checkout must be the canonical repository root");
    await this.assertNoOperation(project);
    if (
      await this.git(project, "status", "--porcelain", "--untracked-files=all")
    )
      throw new BlockedError(
        "Checkout must be clean; unfinished files preserved",
      );
  }
  private async assertNoOperation(project: Project): Promise<void> {
    for (const marker of [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "rebase-merge",
      "rebase-apply",
      "BISECT_LOG",
    ]) {
      const path = await this.git(project, "rev-parse", "--git-path", marker);
      const exists = await access(
        path.startsWith("/") ? path : join(project.checkout, path),
      ).then(
        () => true,
        () => false,
      );
      if (exists) throw new BlockedError(`Unresolved Git operation: ${marker}`);
    }
  }
  async prepare(
    project: Project,
    branch: string,
    signal?: AbortSignal,
  ): Promise<Snapshot> {
    signal?.throwIfAborted();
    await this.check(project);
    const original = await this.inspect(project);
    await this.git(project, "check-ref-format", "--branch", project.baseBranch);
    await this.git(project, "check-ref-format", "--branch", branch);
    const existing = await this.runGit(
      project,
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { signal, allowFailure: true },
    );
    if (existing.exitCode === 0)
      throw new BlockedError(`Branch already exists: ${branch}`);
    await this.runGit(
      project,
      ["fetch", "--no-tags", project.remote, project.baseBranch],
      { signal },
    );
    const base = await this.git(project, "rev-parse", "FETCH_HEAD");
    await this.verify(project, original);
    await this.runGit(project, ["switch", "-c", branch, base], { signal });
    const prepared = await this.inspect(project);
    if (prepared.paths.length)
      throw new BlockedError("Checkout changed during branch preparation");
    return prepared;
  }
  async inspect(project: Project): Promise<Snapshot> {
    await this.assertNoOperation(project);
    const head = await this.git(project, "rev-parse", "HEAD");
    const branch = await this.git(project, "symbolic-ref", "--short", "HEAD");
    const status = await this.git(
      project,
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    );
    const diff = await this.git(
      project,
      "diff",
      "HEAD",
      "--binary",
      "--no-ext-diff",
    );
    const tracked = await this.git(
      project,
      "diff",
      "HEAD",
      "--no-renames",
      "--name-only",
      "-z",
    );
    const untracked = await this.git(
      project,
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    );
    const paths = [
      ...new Set(
        [...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean),
      ),
    ].sort();
    const hash = createHash("sha256")
      .update(head)
      .update(branch)
      .update(status)
      .update(diff);
    let fullDiff = diff;
    const files: Record<string, string | null> = {};
    for (const path of paths) {
      const absolute = join(project.checkout, path);
      try {
        const stat = await lstat(absolute);
        if (stat.isSymbolicLink())
          throw new BlockedError(
            `Changed symlink requires manual handling: ${path}`,
          );
        const content = await readFile(absolute);
        files[path] = createHash("sha256").update(content).digest("hex");
        hash.update(path).update(content).update(String(stat.mode));
        if (untracked.split("\0").includes(path))
          fullDiff += `\n--- /dev/null\n+++ b/${path}\n${content.toString()}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        hash.update(`deleted:${path}`);
        files[path] = null;
      }
    }
    return {
      branch,
      head,
      fingerprint: hash.digest("hex"),
      diff: fullDiff,
      paths,
      files,
    };
  }
  async verify(project: Project, expected: Snapshot): Promise<void> {
    const actual = await this.inspect(project);
    if (actual.fingerprint !== expected.fingerprint)
      throw new BlockedError("Unexpected checkout mutation; files preserved");
  }
  async commit(
    project: Project,
    expected: Snapshot,
    publication: Publication,
    runId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    const runMarkers = publication.commitMessage
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("Agent-Workflows-Run:"));
    if (
      runMarkers.length !== 1 ||
      runMarkers[0] !== `Agent-Workflows-Run: ${runId}`
    )
      throw new BlockedError(
        "Commit message must contain exactly one matching workflow run marker",
      );
    const current = await this.inspect(project);
    if (current.head !== expected.head) {
      const message = await this.git(project, "log", "-1", "--format=%B");
      const parent = await this.git(project, "rev-parse", "HEAD^");
      if (
        parent === expected.head &&
        message.trimEnd() === publication.commitMessage.trimEnd() &&
        current.paths.length === 0
      ) {
        const changed = (
          await this.git(
            project,
            "diff",
            "HEAD^",
            "HEAD",
            "--no-renames",
            "--name-only",
            "-z",
          )
        )
          .split("\0")
          .filter(Boolean)
          .sort();
        if (JSON.stringify(changed) !== JSON.stringify(expected.paths))
          throw new BlockedError(
            "Reconciled commit has an unexpected change set",
          );
        for (const [path, digest] of Object.entries(expected.files)) {
          const actual = await readFile(join(project.checkout, path)).then(
            (content) => createHash("sha256").update(content).digest("hex"),
            (error) => {
              if (error.code === "ENOENT") return null;
              throw error;
            },
          );
          if (actual !== digest)
            throw new BlockedError(
              "Reconciled commit content differs from validated changes",
            );
        }
        return current.head;
      }
      throw new BlockedError("Cannot reconcile commit with recorded changes");
    }
    await this.verify(project, expected);
    if (!expected.paths.length) throw new BlockedError("No changes to commit");
    await this.runGit(project, ["add", "--", ...expected.paths], { signal });
    await this.runGit(
      project,
      [
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-m",
        publication.commitMessage,
      ],
      { signal },
    );
    return this.git(project, "rev-parse", "HEAD");
  }
  async push(
    project: Project,
    branch: string,
    head: string,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    await this.check(project);
    if ((await this.git(project, "rev-parse", "HEAD")) !== head)
      throw new BlockedError("Head changed before push");
    const result = await this.runGit(
      project,
      ["ls-remote", "--heads", project.remote, `refs/heads/${branch}`],
      { signal },
    );
    const existing = result.stdout.trimEnd();
    if (existing && existing.split(/\s/)[0] !== head)
      throw new BlockedError("Remote branch changed; refusing overwrite");
    if (!existing)
      await this.runGit(
        project,
        ["push", project.remote, `${head}:refs/heads/${branch}`],
        { signal },
      );
  }
  async release(project: Project): Promise<void> {
    await this.check(project);
  }
}
