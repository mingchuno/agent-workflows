import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

/** Resolve recorded evidence only within the canonical workflow state directory. */
export async function resolveEvidencePath(
  stateDirectory: string,
  recordedPath: string,
): Promise<string | undefined> {
  const root = await realpath(stateDirectory);
  const path = await realpath(recordedPath);
  const within = relative(root, path);
  if (
    !within ||
    within === ".." ||
    within.startsWith("../") ||
    isAbsolute(within)
  )
    return undefined;
  return path;
}
