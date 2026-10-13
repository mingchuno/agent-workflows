import { randomUUID } from "node:crypto";
import {
  link,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type Configuration, configSchema } from "./config.js";
import { sha256 } from "./prompts.js";

const controlSchema = z.strictObject({
  id: z.string(),
  databaseUrlEnv: z.string(),
  databaseUrlHash: z.string(),
  envFile: z.string().optional(),
  pid: z.number().int().positive(),
  nonce: z.string(),
  configuration: configSchema.optional(),
});
type RunnerControl = z.infer<typeof controlSchema>;

function controlPath(configPath: string): string {
  return join(
    tmpdir(),
    `agent-workflows-${process.getuid?.() ?? "local"}-${sha256(configPath)}.json`,
  );
}
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
async function readControl(path: string): Promise<RunnerControl | undefined> {
  try {
    return controlSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Local startup locator, containing environment names/paths but no credentials. */
export async function publishRunnerControl(
  configPath: string,
  connection: Pick<
    RunnerControl,
    "id" | "databaseUrlEnv" | "databaseUrlHash" | "envFile" | "configuration"
  >,
): Promise<() => Promise<void>> {
  const path = controlPath(configPath);
  const existing = await readControl(path);
  if (existing) {
    if (processExists(existing.pid))
      throw new Error("Another runner uses this configuration path");
    await unlink(path);
  }
  const record: RunnerControl = {
    ...connection,
    pid: process.pid,
    nonce: randomUUID(),
  };
  const temporary = `${path}.${record.nonce}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(record), {
      flag: "wx",
      mode: 0o600,
    });
    // Publish complete bytes without replacing another runner's locator.
    await link(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return async () => {
    if ((await readControl(path))?.nonce === record.nonce) await unlink(path);
  };
}

export class RunnerControlUnavailableError extends Error {}

export async function readRunnerControl(
  configPath: string,
): Promise<RunnerControl> {
  const record = await findRunnerControl(configPath);
  if (!record)
    throw new RunnerControlUnavailableError(
      "No active runner control record for this configuration path; start the runner first",
    );
  return record;
}

/** Readers only return a configuration published by a live runner in this scope. */
export async function readActiveConfiguration(
  configPath: string,
  scope: string,
): Promise<Configuration> {
  const control = await readRunnerControl(configPath);
  if (control.id !== scope || !control.configuration)
    throw new Error("Active runner configuration unavailable for this scope");
  return control.configuration;
}

export async function publishActiveConfiguration(
  configPath: string,
  configuration: Configuration,
): Promise<void> {
  const path = controlPath(configPath);
  const control = await readRunnerControl(configPath);
  if (control.pid !== process.pid || control.id !== configuration.id)
    throw new Error("Cannot publish another runner's configuration");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ ...control, configuration }), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function findRunnerControl(
  configPath: string,
): Promise<RunnerControl | undefined> {
  const record = await readControl(controlPath(configPath));
  return record && processExists(record.pid) ? record : undefined;
}
