import { readFile, writeFile } from "node:fs/promises";
import { CopilotClient } from "@github/copilot-sdk";
import { Codex } from "@openai/codex-sdk";
import { runCodex, runCopilot, type WorkerInput } from "./sdk-protocol.js";

const input = JSON.parse(
  await readFile(process.argv[2]!, "utf8"),
) as WorkerInput;
if (input.processFile)
  await writeFile(input.processFile, JSON.stringify({ pid: process.pid }), {
    mode: 0o600,
  });
const emit = (type: string, value: unknown) => {
  process.stdout.write(`AW:${JSON.stringify({ type, value })}\n`);
};
if (input.provider === "codex") await runCodex(new Codex(), input, emit);
else await runCopilot(new CopilotClient(), input, emit);
