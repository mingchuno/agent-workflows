import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const defaultConfigName = "agent-workflows.json";

/** Directory searched for configurations that claim the current checkout. */
export function configHome(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.AGENT_WORKFLOWS_HOME ||
    join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agent-workflows")
  );
}

const identities = new Map<string, string | undefined>();
/** The Git common directory identifies a repository across linked worktrees. */
function repositoryIdentity(directory: string): string | undefined {
  if (!identities.has(directory)) {
    let identity: string | undefined;
    try {
      identity = realpathSync(
        execFileSync(
          "git",
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          {
            cwd: directory,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          },
        ).trim(),
      );
    } catch {
      identity = undefined;
    }
    identities.set(directory, identity);
  }
  return identities.get(directory);
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** True when `directory` is inside `checkout` or one of its linked worktrees. */
export function withinCheckout(directory: string, checkout: string): boolean {
  const here = canonical(directory);
  const root = canonical(checkout);
  if (here === root || here.startsWith(root + "/")) return true;
  const identity = repositoryIdentity(here);
  return identity !== undefined && identity === repositoryIdentity(root);
}

function claimedCheckouts(path: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      projects?: { checkout?: unknown }[];
    };
    if (!Array.isArray(parsed.projects)) return [];
    return parsed.projects
      .map((project) => project?.checkout)
      .filter((checkout): checkout is string => typeof checkout === "string")
      .map((checkout) => resolve(dirname(path), checkout));
  } catch {
    return [];
  }
}

/** Find the single configuration in `home` whose project contains `directory`. */
export function discoverConfigPath(
  directory: string,
  home: string,
): string | undefined {
  let names: string[];
  try {
    names = readdirSync(home).filter((name) => name.endsWith(".json"));
  } catch {
    return undefined;
  }
  const matches = names
    .sort()
    .map((name) => join(home, name))
    .filter((path) =>
      claimedCheckouts(path).some((checkout) =>
        withinCheckout(directory, checkout),
      ),
    );
  if (matches.length > 1)
    throw new Error(
      `Several configurations in ${home} manage this checkout: ${matches.join(", ")}. Pass --config PATH.`,
    );
  return matches[0];
}

/**
 * Resolve the configuration path: `--config`, then `AGENT_WORKFLOWS_CONFIG`,
 * then `agent-workflows.json` in the launch directory, then the single
 * configuration in the config home that manages the launch directory.
 */
export function resolveConfigPath(
  launchDirectory: string,
  explicit: string | undefined,
  options: { discover: boolean; env?: NodeJS.ProcessEnv },
): string {
  const env = options.env ?? process.env;
  const selected = explicit ?? env.AGENT_WORKFLOWS_CONFIG;
  if (selected) return resolve(launchDirectory, selected);
  const local = resolve(launchDirectory, defaultConfigName);
  if (!options.discover || existsSync(local)) return local;
  return discoverConfigPath(launchDirectory, configHome(env)) ?? local;
}
