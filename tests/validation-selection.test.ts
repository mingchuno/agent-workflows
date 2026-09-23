import assert from "node:assert/strict";
import { test } from "node:test";
import { projectSchema } from "../src/config.js";
import { selectValidation } from "../src/validation-selection.js";

const project = projectSchema.parse({
  id: "example",
  checkout: "/tmp",
  hosting: {
    provider: "github",
    origin: "https://github.com",
    repository: "a/b",
    tokenEnv: "TOKEN",
  },
  agent: { provider: "codex" },
  validation: [{ command: "pnpm", args: ["lint"] }],
  validationProfiles: {
    migration: [{ command: "pnpm", args: ["test:migrations"] }],
  },
});

test("ticket block adds configured checks after the baseline", () => {
  const selected = selectValidation(
    "Update migration.\n\n```agent-workflows-validation\nmigration\n```\n",
    project,
  );
  assert.equal(selected.profile, "migration");
  assert.deepEqual(
    selected.commands.map(({ command, args }) => [command, ...args]),
    [
      ["pnpm", "lint"],
      ["pnpm", "test:migrations"],
    ],
  );
  assert.deepEqual(
    selectValidation("No block", project).commands,
    project.validation,
  );
});

test("unknown, duplicate and malformed ticket selections fail", () => {
  const block = (name: string) =>
    `\`\`\`agent-workflows-validation\n${name}\n\`\`\``;
  for (const body of [
    block("unknown"),
    block("migration\nother"),
    block("migration") + "\n" + block("migration"),
    "```agent-workflows-validation\nmigration",
  ]) {
    assert.throws(() => selectValidation(body, project), /validation/i);
  }
});

test("profile names and configured commands are validated", () => {
  assert.equal(
    projectSchema.safeParse({
      ...project,
      validationProfiles: { "bad name": [{ command: "pnpm" }] },
    }).success,
    false,
  );
  assert.equal(
    projectSchema.safeParse({
      ...project,
      validationProfiles: { migration: [{ command: "" }] },
    }).success,
    false,
  );
});
