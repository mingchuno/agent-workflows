import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  configSchema,
  createAgents,
  createHosting,
  Runner,
} from "@mingchuno/agent-workflows";
import { reportingWorkflow } from "./custom-workflow.js";

const configPath = resolve(process.argv[2] ?? "agent-workflows.json");
const config = configSchema.parse(
  JSON.parse(await readFile(configPath, "utf8")),
);
const databaseUrl = process.env[config.databaseUrlEnv];
if (!databaseUrl) throw new Error(`Set ${config.databaseUrlEnv}`);
const runner = new Runner({
  config,
  pathBaseDirectory: dirname(configPath),
  databaseUrl,
  hosting: createHosting,
  agents: createAgents(),
  workflow: reportingWorkflow,
  workflowVersion: "reporting-v1",
});
try {
  await runner.start();
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
} finally {
  await runner.shutdown();
}
