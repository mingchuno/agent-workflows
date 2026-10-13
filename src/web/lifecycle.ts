import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Configuration } from "../config.js";
import { createRedactor } from "../runtime/redaction.js";

export interface WebStartup {
  scope: string;
  configPath: string;
  databaseUrl: string;
  stateDirectory: string;
  projectIds: string[];
  port: number;
  token: string;
}

/** The CLI owns this optional child; workflow execution never waits for it. */
export function startWebMonitor(options: {
  config: Configuration;
  configPath: string;
  databaseUrl: string;
  port: number;
}) {
  const token = randomBytes(32).toString("hex");
  const redact = createRedactor([token, options.databaseUrl]);
  const worker = new URL(
    import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js",
    import.meta.url,
  );
  const child = fork(worker, [], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stopping = false;
  let warned = false;
  const warn = (message: string) => {
    if (stopping || warned) return;
    warned = true;
    console.error(
      `Web monitor unavailable: ${redact(message)}. Workflows continue; use monitor in another terminal.`,
    );
  };
  const timer = setTimeout(() => {
    warn("startup timed out");
    child.kill("SIGTERM");
  }, 10_000);
  child.on("message", (message: unknown) => {
    if (!message || typeof message !== "object") return;
    if ("ready" in message && message.ready === true) {
      clearTimeout(timer);
      if (!stopping)
        console.log(
          `Web monitor: http://127.0.0.1:${options.port}/?token=${token}`,
        );
    } else if ("error" in message && typeof message.error === "string") {
      clearTimeout(timer);
      warn(message.error);
    }
  });
  child.on("error", (error) => {
    clearTimeout(timer);
    warn(error.message);
  });
  child.stderr?.on("data", (chunk: Buffer) =>
    warn(chunk.toString("utf8").slice(0, 1000)),
  );
  const closed = new Promise<void>((done) =>
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      warn(`server exited (${signal ?? code})`);
      done();
    }),
  );
  const startup: WebStartup = {
    scope: options.config.id,
    configPath: options.configPath,
    databaseUrl: options.databaseUrl,
    stateDirectory: options.config.stateDirectory,
    projectIds: options.config.projects.map((project) => project.id),
    port: options.port,
    token,
  };
  child.send(startup, (error) => {
    if (error) warn(error.message);
  });
  return async () => {
    stopping = true;
    clearTimeout(timer);
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 2000);
    try {
      await closed;
    } finally {
      clearTimeout(force);
    }
  };
}
