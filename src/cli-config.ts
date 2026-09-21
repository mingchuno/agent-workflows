import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { z } from "zod";
import { type Configuration, configSchema } from "./config.js";

const cliConfigurationSchema = configSchema.extend({
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
  const { envFile, ...configuration } = cliConfigurationSchema.parse(
    JSON.parse(await readFile(path, "utf8")),
  );
  if (envFile !== undefined)
    await loadEnvironmentFile(resolveEnvironmentFile(envFile));
  return configuration;
}

async function loadEnvironmentFile(path: string): Promise<void> {
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
