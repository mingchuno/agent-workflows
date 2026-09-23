import { spawn } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";

export const maxCapturedOutputBytes = 32 * 1024 * 1024;

export interface CommandOptions {
  cwd: string;
  processFile?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  killGraceMs?: number;
  env?: NodeJS.ProcessEnv;
  allowFailure?: boolean;
  captureOutput?: boolean;
  strictUtf8?: boolean;
  onOutput?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
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
        if ((error as NodeJS.ErrnoException).code !== "ESRCH")
          failure = failure
            ? new AggregateError(
                [failure, error],
                `${String(failure)}; process group termination failed: ${String(error)}`,
              )
            : error;
      }
    };
    const stop = () => {
      if (cancelled) return;
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
    const decoders = {
      stdout: new TextDecoder("utf-8", {
        fatal: options.strictUtf8,
        ignoreBOM: true,
      }),
      stderr: new TextDecoder("utf-8", {
        fatal: options.strictUtf8,
        ignoreBOM: true,
      }),
    };
    let capturedBytes = 0;
    const decodeOutput = (target: "stdout" | "stderr", chunk?: Buffer) => {
      try {
        const value = decoders[target].decode(chunk, {
          stream: chunk !== undefined,
        });
        if (value) {
          if (target === "stderr" && options.onStderr) options.onStderr(value);
          else options.onOutput?.(value);
        }
        if (options.captureOutput !== false) {
          if (target === "stdout") stdout += value;
          else stderr += value;
        }
      } catch (error) {
        failure ??= error;
        stop();
      }
    };
    const collect = (target: "stdout" | "stderr", chunk: Buffer) => {
      if (options.captureOutput !== false) {
        capturedBytes += chunk.length;
        if (capturedBytes > maxCapturedOutputBytes) {
          failure ??= new Error(
            `Command output size ${capturedBytes} bytes exceeds capture limit ${maxCapturedOutputBytes} bytes`,
          );
          stop();
          return;
        }
      }
      decodeOutput(target, chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.stdout.on("end", () => decodeOutput("stdout"));
    child.stderr.on("end", () => decodeOutput("stderr"));
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
