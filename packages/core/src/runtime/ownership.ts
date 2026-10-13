import { open, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { BlockedError } from "../domain.js";
import { command } from "./process.js";

export function processExists(pid: number, group = false): boolean {
  try {
    process.kill(group && process.platform !== "win32" ? -pid : pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
export async function assertProcessesStopped(directory: string): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await assertProcessesStopped(path);
    else if (entry.name.endsWith(".process.json")) {
      const record = JSON.parse(await readFile(path, "utf8")) as {
        pid: number;
      };
      if (processExists(record.pid, true))
        throw new BlockedError(
          `Previous process group ${record.pid} is still alive; inspect ${path} before recovery`,
        );
    }
  }
}
/** Filesystem lease prevents different databases/configurations owning one checkout. */
export class CheckoutOwnership {
  private readonly paths: string[] = [];
  async acquire(checkout: string, artifacts: string): Promise<void> {
    const gitDirectory = (
      await command("git", ["rev-parse", "--absolute-git-dir"], {
        cwd: checkout,
      })
    ).stdout.trim();
    const path = join(gitDirectory, "agent-workflows-owner.json");
    let guard: Awaited<ReturnType<typeof open>>;
    try {
      guard = await open(path + ".acquiring", "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new BlockedError(
          `Checkout acquisition is locked: ${path}.acquiring; inspect its owner before removing a stale guard`,
        );
      throw error;
    }
    try {
      await guard.writeFile(JSON.stringify({ pid: process.pid }));
      await assertProcessesStopped(
        join(gitDirectory, "agent-workflows-processes"),
      );
      try {
        const previous = JSON.parse(await readFile(path, "utf8")) as {
          pid: number;
          artifacts: string;
        };
        if (processExists(previous.pid))
          throw new BlockedError(
            `Checkout owned by process ${previous.pid}: ${checkout}`,
          );
        await assertProcessesStopped(previous.artifacts);
        await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const file = await open(path, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify({ pid: process.pid, artifacts }));
        this.paths.push(path);
      } finally {
        await file.close();
      }
    } finally {
      await guard.close();
      await unlink(path + ".acquiring");
    }
  }

  async release(): Promise<void> {
    for (const path of this.paths.splice(0)) await unlink(path);
  }
}
