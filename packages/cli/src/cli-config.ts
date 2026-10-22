import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import {
  type Configuration,
  configurationInputSchema,
  resolveConfiguration,
} from "@mingchuno/agent-workflows-core";
import { z } from "zod";
import { applyCliTokens } from "./hosting-token.js";

const cliConfigurationSchema = configurationInputSchema.extend({
  envFile: z
    .string()
    .refine(
      (path) => path.trim().length > 0,
      "Environment file path must be nonblank",
    )
    .optional(),
});

export async function readCliConfiguration(
  path: string,
  resolveEnvironmentFile: (path: string) => string,
): Promise<Configuration> {
  return (await openCliConfiguration(path, resolveEnvironmentFile)).config;
}

/** Capture the startup environment source; reload never mutates process.env. */
export async function openCliConfiguration(
  path: string,
  resolveEnvironmentFile: (path: string) => string,
) {
  const { envFile, ...config } = await readConfigurationFile(path);
  if (envFile !== undefined)
    await loadEnvironmentFile(resolveEnvironmentFile(envFile));
  applyCliTokens(config.projects);
  return {
    config,
    envFile:
      envFile === undefined ? undefined : resolveEnvironmentFile(envFile),
    async reload(): Promise<Configuration> {
      const { envFile: candidateEnvFile, ...candidate } =
        await readConfigurationFile(path);
      if (candidateEnvFile !== envFile)
        throw new Error("Configuration changes require restart: envFile");
      const ids = (configuration: Configuration) =>
        configuration.projects.map((project) => project.id).sort();
      if (JSON.stringify(ids(config)) !== JSON.stringify(ids(candidate)))
        throw new Error(
          "Configuration changes require restart: projects (IDs or membership)",
        );
      return candidate;
    },
  };
}

export async function readConfigurationFile(path: string) {
  const { envFile, ...input } = cliConfigurationSchema.parse(
    JSON.parse(await readFile(path, "utf8")),
  );
  return { ...resolveConfiguration(input), envFile };
}

export async function loadEnvironmentFile(path: string): Promise<void> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(
      `Cannot read environment file ${path} (${(error as NodeJS.ErrnoException).code ?? "read failed"})`,
    );
  }
  let values: NodeJS.Dict<string>;
  try {
    values = parseEnv(contents);
  } catch (error) {
    throw new Error(`Cannot parse environment file ${path}`, { cause: error });
  }
  for (const [name, value] of Object.entries(values))
    if (value !== undefined && process.env[name] === undefined)
      process.env[name] = value;
}
