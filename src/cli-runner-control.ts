import { randomUUID } from "node:crypto";
import { link, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { sha256 } from "./prompts.js";

const controlSchema = z.strictObject({
  id: z.string(),
  databaseUrlEnv: z.string(),
  databaseUrlHash: z.string(),
  envFile: z.string().optional(),
  pid: z.number().int().positive(),
  nonce: z.string(),
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
    "id" | "databaseUrlEnv" | "databaseUrlHash" | "envFile"
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

export async function readRunnerControl(
  configPath: string,
): Promise<RunnerControl> {
  const record = await readControl(controlPath(configPath));
  if (!record || !processExists(record.pid))
    throw new Error(
      "No active runner control record for this configuration path; start the runner first",
    );
  return record;
}
