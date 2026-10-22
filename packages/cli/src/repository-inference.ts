import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, delimiter, join } from "node:path";

export interface RemoteRepository {
  provider: "github" | "gitlab";
  origin: string;
  repository: string;
}

function git(directory: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/** Parse an SSH, scp-style or HTTPS Git remote into hosting settings. */
export function parseRemote(url: string): RemoteRepository | undefined {
  let host: string;
  let path: string;
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(url);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    try {
      const parsed = new URL(url);
      if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol))
        return undefined;
      host = parsed.hostname;
      path = parsed.pathname;
    } catch {
      return undefined;
    }
  }
  const repository = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (!host || repository.split("/").length < 2) return undefined;
  const provider =
    host === "github.com" || host.includes("github") ? "github" : "gitlab";
  if (provider === "github" && repository.split("/").length !== 2)
    return undefined;
  return { provider, origin: `https://${host}`, repository };
}

export function remoteRepository(
  directory: string,
): RemoteRepository | undefined {
  const url = git(directory, ["remote", "get-url", "origin"]);
  return url ? parseRemote(url) : undefined;
}

export function onPath(executable: string): boolean {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .some((directory) => directory && existsSync(join(directory, executable)));
}

function packageScripts(checkout: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(
      readFileSync(join(checkout, "package.json"), "utf8"),
    );
    return parsed && typeof parsed.scripts === "object" ? parsed.scripts : {};
  } catch {
    return {};
  }
}

function packageManager(checkout: string): string {
  if (existsSync(join(checkout, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(checkout, "yarn.lock"))) return "yarn";
  if (
    existsSync(join(checkout, "bun.lock")) ||
    existsSync(join(checkout, "bun.lockb"))
  )
    return "bun";
  return "npm";
}

/** The project's own baseline check, or none when nothing obvious exists. */
export function inferValidation(
  checkout: string,
): { command: string; args: string[] }[] {
  const scripts = packageScripts(checkout);
  const script = ["verify", "test"].find(
    (name) => typeof scripts[name] === "string",
  );
  if (script)
    return [{ command: packageManager(checkout), args: ["run", script] }];
  if (existsSync(join(checkout, "Cargo.toml")))
    return [{ command: "cargo", args: ["test"] }];
  if (existsSync(join(checkout, "go.mod")))
    return [{ command: "go", args: ["test", "./..."] }];
  try {
    if (/^test:/m.test(readFileSync(join(checkout, "Makefile"), "utf8")))
      return [{ command: "make", args: ["test"] }];
  } catch {
    // No Makefile.
  }
  return [];
}

export interface InferredProject {
  id: string;
  checkout: string;
  hosting: RemoteRepository & { tokenEnv: string };
  baseBranch: string;
  agent: { provider: "codex" | "copilot" };
  validation: { command: string; args: string[] }[];
  /** Values `init` could not discover and the human must replace. */
  placeholders: string[];
}

export function inferProject(directory: string): InferredProject {
  const checkout =
    git(directory, ["rev-parse", "--show-toplevel"]) ?? directory;
  const placeholders: string[] = [];
  let remote = remoteRepository(checkout);
  if (!remote) {
    placeholders.push("hosting.repository");
    remote = {
      provider: "github",
      origin: "https://github.com",
      repository: "OWNER/REPOSITORY",
    };
  }
  const head = git(checkout, [
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  const id =
    basename(checkout)
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project";
  return {
    id,
    checkout,
    hosting: {
      ...remote,
      tokenEnv: remote.provider === "github" ? "GITHUB_TOKEN" : "GITLAB_TOKEN",
    },
    baseBranch: head?.replace(/^origin\//, "") || "main",
    agent: {
      provider: !onPath("codex") && onPath("copilot") ? "copilot" : "codex",
    },
    validation: inferValidation(checkout),
    placeholders,
  };
}
