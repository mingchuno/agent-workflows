import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  type Configuration,
  type Project,
  Store,
} from "@mingchuno/agent-workflows-core";
import type { Command } from "commander";
import { findRunnerControl, monitorAddress } from "./cli-runner-control.js";
import { withinCheckout } from "./config-discovery.js";
import { applyCliTokens, cliTokenAllowed } from "./hosting-token.js";
import { onPath, remoteRepository } from "./repository-inference.js";

type Status = "pass" | "warn" | "fail";
interface Check {
  name: string;
  status: Status;
  detail: string;
}
export interface DoctorReport {
  ok: boolean;
  version: string;
  configPath?: string;
  project?: string;
  /** The running web monitor, without its access token. */
  monitorUrl?: string;
  protocols: { inline: true; delegated: boolean };
  checks: Check[];
}

interface DoctorDependencies {
  version: string;
  launchDirectory: string;
  configPath(): string;
  configBaseDirectory(): string;
  configuration(): Promise<Configuration>;
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function apiRequest(project: Project): { url: string; headers: HeadersInit } {
  const origin = project.hosting.origin.replace(/\/$/, "");
  const token = process.env[project.hosting.tokenEnv] ?? "";
  if (project.hosting.provider === "github")
    return {
      url: `${origin === "https://github.com" ? "https://api.github.com" : `${origin}/api/v3`}/repos/${project.hosting.repository}`,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
      },
    };
  return {
    url: `${origin}/api/v4/projects/${encodeURIComponent(project.hosting.repository)}`,
    headers: { "private-token": token },
  };
}

/** One read of the configured repository proves the token and the name. */
async function checkHostingAccess(project: Project): Promise<Check> {
  const { url, headers } = apiRequest(project);
  try {
    const response = await fetch(url, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok)
      return {
        name: "hosting-access",
        status: "pass",
        detail: `Read ${project.hosting.repository}`,
      };
    const reason =
      response.status === 401
        ? "the token was rejected"
        : response.status === 404 || response.status === 403
          ? "the repository was not found or the token cannot read it"
          : `the host answered ${response.status}`;
    return {
      name: "hosting-access",
      status: "fail",
      detail: `Cannot read ${project.hosting.repository}: ${reason}. Check hosting.repository and the token's repository access.`,
    };
  } catch (error) {
    return {
      name: "hosting-access",
      status: "warn",
      detail: `Could not reach ${project.hosting.origin}: ${message(error)}`,
    };
  }
}

function agentCheck(project: Project): Check {
  const provider = project.agent.provider;
  if (provider === "codex") {
    const home =
      process.env.CODEX_HOME || resolve(process.env.HOME ?? "", ".codex");
    const signedIn =
      Boolean(process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY) ||
      existsSync(resolve(home, "auth.json"));
    return signedIn
      ? { name: "agent", status: "pass", detail: "Codex sign-in found" }
      : {
          name: "agent",
          status: "warn",
          detail: "No Codex sign-in found. Run `codex login`.",
        };
  }
  const signedIn =
    Boolean(process.env.COPILOT_GITHUB_TOKEN) ||
    existsSync(resolve(process.env.HOME ?? "", ".copilot"));
  return signedIn
    ? { name: "agent", status: "pass", detail: "Copilot sign-in found" }
    : {
        name: "agent",
        status: "warn",
        detail: "No Copilot sign-in found. Run `copilot` and sign in.",
      };
}

function validationCheck(project: Project, checkout: string): Check {
  const missing = project.validation
    .map((item) => item.command)
    .filter((command) =>
      command.includes("/")
        ? !existsSync(
            isAbsolute(command) ? command : resolve(checkout, command),
          )
        : !onPath(command),
    );
  if (!project.validation.length)
    return {
      name: "validation",
      status: "warn",
      detail:
        "No validation commands. Add the project's checks to `validation`.",
    };
  return missing.length
    ? {
        name: "validation",
        status: "fail",
        detail: `Not found: ${[...new Set(missing)].join(", ")}`,
      }
    : {
        name: "validation",
        status: "pass",
        detail: project.validation
          .map((item) => [item.command, ...item.args].join(" "))
          .join("; "),
      };
}

export async function doctor(
  dependencies: DoctorDependencies,
  options: { project?: string },
): Promise<DoctorReport> {
  const checks: Check[] = [];
  const check = (name: string, status: Status, detail: string) =>
    checks.push({ name, status, detail });
  let monitorUrl: string | undefined;
  const report = (project?: string): DoctorReport => {
    let configPath: string | undefined;
    try {
      configPath = dependencies.configPath();
    } catch {
      // Ambiguous discovery is already reported as the configuration check.
    }
    const ok = checks.every((item) => item.status !== "fail");
    return {
      ok,
      version: dependencies.version,
      configPath,
      project,
      ...(monitorUrl ? { monitorUrl } : {}),
      protocols: { inline: true, delegated: ok },
      checks,
    };
  };
  let config: Configuration;
  try {
    config = await dependencies.configuration();
    check("configuration", "pass", dependencies.configPath());
  } catch (error) {
    check(
      "configuration",
      "fail",
      `${message(error)}. Run \`agent-workflows init\` in the repository, or ask start-work to set it up.`,
    );
    return report();
  }
  const base = dependencies.configBaseDirectory();
  const project = options.project
    ? config.projects.find((candidate) => candidate.id === options.project)
    : config.projects.find((candidate) =>
        withinCheckout(
          dependencies.launchDirectory,
          resolve(base, candidate.checkout),
        ),
      );
  if (!project) {
    check(
      "project",
      "fail",
      options.project
        ? `Unknown project: ${options.project}`
        : `No configured project checkout contains ${dependencies.launchDirectory}`,
    );
    return report();
  }
  check("project", "pass", project.id);
  const checkout = resolve(base, project.checkout);
  if (project.hosting.repository === "OWNER/REPOSITORY")
    check(
      "repository",
      "fail",
      "hosting.repository is still the OWNER/REPOSITORY placeholder",
    );
  else {
    const remote = remoteRepository(checkout);
    const matches =
      !remote ||
      (remote.repository.toLowerCase() ===
        project.hosting.repository.toLowerCase() &&
        remote.origin === new URL(project.hosting.origin).origin);
    check(
      "repository",
      matches ? "pass" : "warn",
      matches
        ? `${project.hosting.origin} ${project.hosting.repository}`
        : `Configured ${project.hosting.origin} ${project.hosting.repository}, but origin is ${remote!.origin} ${remote!.repository}`,
    );
  }
  check(
    "sdlc",
    project.sdlc.enabled ? "pass" : "fail",
    project.sdlc.enabled
      ? `approval source ${project.sdlc.approvalSource}`
      : "Set sdlc.enabled for this project to delegate Track B and C work",
  );
  const source = applyCliTokens([project]).get(project.id);
  const tool = project.hosting.provider === "github" ? "gh" : "glab";
  check(
    "hosting-credentials",
    source ? "pass" : "fail",
    source === "environment"
      ? `${project.hosting.tokenEnv} is set`
      : source
        ? `Using the ${source} sign-in`
        : cliTokenAllowed(project)
          ? `Sign in with \`${tool} auth login\`, or set ${project.hosting.tokenEnv}`
          : `Set ${project.hosting.tokenEnv}, or set hosting.tokenFromCli to use the ${tool} sign-in`,
  );
  if (source && project.hosting.repository !== "OWNER/REPOSITORY")
    checks.push(await checkHostingAccess(project));
  checks.push(agentCheck(project));
  checks.push(validationCheck(project, checkout));
  try {
    const url = process.env[config.databaseUrlEnv];
    if (!url)
      throw new Error(`Set ${config.databaseUrlEnv} to a PostgreSQL URL`);
    const store = new Store(url, config.id);
    try {
      await Promise.race([
        store.initialize().then(() => store.projects()),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Database connection timed out")),
            10_000,
          ).unref(),
        ),
      ]);
      check("database", "pass", "Connected and migrated");
    } finally {
      await store.close();
    }
  } catch (error) {
    check("database", "fail", message(error));
  }
  const worker = await findRunnerControl(dependencies.configPath());
  if (worker?.webUrl) monitorUrl = monitorAddress(worker.webUrl);
  check(
    "worker",
    worker ? "pass" : "warn",
    worker
      ? `Running as process ${worker.pid}${monitorUrl ? `; web monitor ${monitorUrl}` : ""}`
      : "Not running. Start `agent-workflows run` in its own terminal; approved work waits until then.",
  );
  return report(project.id);
}

const symbols: Record<Status, string> = { pass: "✓", warn: "!", fail: "✗" };

export function formatDoctor(report: DoctorReport): string {
  const width = Math.max(...report.checks.map((item) => item.name.length));
  const failing = report.checks.filter((item) => item.status === "fail");
  return [
    `agent-workflows ${report.version}${report.configPath ? `  ${report.configPath}` : ""}`,
    "",
    ...report.checks.map(
      (item) =>
        `${symbols[item.status]} ${item.name.padEnd(width)}  ${item.detail}`,
    ),
    "",
    report.ok
      ? "Ready: start-work can delegate Track B and C work."
      : `Delegated work unavailable: fix ${failing.length} failing check${failing.length === 1 ? "" : "s"}. Track A work runs inline without setup.`,
  ].join("\n");
}

export function registerDoctor(
  program: Command,
  dependencies: DoctorDependencies,
): void {
  program
    .command("doctor")
    .description("Check what start-work needs and say how to fix each gap")
    .option(
      "-p, --project <id>",
      "project to check (default: the project whose checkout contains the current directory)",
    )
    .option("--json", "machine-readable output")
    .action(async (options: { project?: string; json?: boolean }) => {
      const result = await doctor(dependencies, options);
      console.log(
        options.json ? JSON.stringify(result, null, 2) : formatDoctor(result),
      );
      if (!result.ok) process.exitCode = 1;
    });
}
