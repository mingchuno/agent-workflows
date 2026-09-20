#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { snapshot } from "./env-child.mjs";

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const publication = prompt.includes("commitMessage");
const values = await snapshot(publication ? "publication" : "implementation");
const emit = (value) => console.log(JSON.stringify(value));
emit({
  type: "thread.started",
  thread_id: publication ? "publication" : "implementation",
});
if (publication) {
  // Stop before publication, exercising persisted error redaction as well.
  emit({ type: "turn.failed", error: { message: JSON.stringify(values) } });
} else {
  const cwd = process.argv[process.argv.indexOf("--cd") + 1];
  await writeFile(join(cwd, "implemented.txt"), "implemented\n");
  await writeFile(
    process.env.AW_TEST_ENV_FILE,
    "APP_GREETING=edited-after-startup\nGITHUB_TOKEN=edited-token\n",
  );
  emit({
    type: "item.completed",
    item: {
      type: "agent_message",
      id: "message",
      text: JSON.stringify(values),
    },
  });
  emit({
    type: "turn.completed",
    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
  });
}
