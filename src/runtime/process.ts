import { spawn } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";

export interface CommandOptions {
  cwd: string;
  processFile?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  killGraceMs?: number;
  env?: NodeJS.ProcessEnv;
  allowFailure?: boolean;
  captureOutput?: boolean;
  onOutput?: (chunk: string) => void;
}
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
/** Resolves only after the child closes. Cancellation terminates its process group. */
export function command(
  executable: string,
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      cancelled = false,
      killTimer: NodeJS.Timeout | undefined;
    let failure: unknown;
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure = error;
      }
    };
    const stop = () => {
      cancelled = true;
      kill("SIGTERM");
      killTimer ??= setTimeout(
        () => kill("SIGKILL"),
        options.killGraceMs ?? 2000,
      );
    };
    try {
      if (options.processFile && child.pid)
        writeFileSync(options.processFile, JSON.stringify({ pid: child.pid }), {
          mode: 0o600,
        });
    } catch (error) {
      failure = error;
      stop();
    }
    const timeout = setTimeout(stop, options.timeoutMs ?? 300_000);
    options.signal?.addEventListener("abort", stop, { once: true });
    const collect = (target: "stdout" | "stderr", chunk: Buffer) => {
      const value = chunk.toString();
      try {
        options.onOutput?.(value);
      } catch (error) {
        failure = error;
        stop();
      }
      if (
        options.captureOutput !== false &&
        stdout.length + stderr.length <= 32 * 1024 * 1024
      ) {
        if (target === "stdout") stdout += value;
        else stderr += value;
        if (stdout.length + stderr.length > 32 * 1024 * 1024) stop();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    const cleanup = () => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", stop);
    };
    child.on("error", (error) => {
      failure = error;
    });
    child.on("close", (code) => {
      // Kill any descendants left behind by a command that exited before them.
      kill("SIGKILL");
      cleanup();
      if (options.processFile) {
        try {
          unlinkSync(options.processFile);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            return reject(error);
        }
      }
      if (failure) return reject(failure);
      if (cancelled)
        return reject(
          new Error("Command cancelled or timed out; process group terminated"),
        );
      if (code !== 0 && !options.allowFailure)
        return reject(
          new Error(`${executable} failed (${code}): ${stderr.trim()}`),
        );
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}
