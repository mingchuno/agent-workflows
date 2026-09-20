import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { configSchema } from "../src/config.js";
import { command } from "../src/runtime/process.js";

test("CLI init creates valid configuration and refuses overwrites", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aw-cli-"));
  const file = join(directory, "config.json");
  const args = [
    "--import",
    "tsx",
    resolve("src/cli.ts"),
    "--config",
    file,
    "init",
  ];
  await command(process.execPath, args, { cwd: process.cwd() });
  const original = await readFile(file, "utf8");
  assert.doesNotMatch(original, /"prompt"|"promptFile"|"skills"|"writing"/);
  assert.equal(configSchema.parse(JSON.parse(original)).projects.length, 1);
  const retry = await command(process.execPath, args, {
    cwd: process.cwd(),
    allowFailure: true,
  });
  assert.equal(retry.exitCode, 1);
  assert.equal(await readFile(file, "utf8"), original);
});
test("CLI reports missing configuration and supports noninteractive help", async () => {
  const result = await command(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/cli.ts",
      "--config",
      "/nonexistent/config.json",
      "status",
      "--json",
    ],
    { cwd: process.cwd(), allowFailure: true },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /ENOENT/);
  assert.match(
    (
      await command(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "--help"],
        { cwd: process.cwd() },
      )
    ).stdout,
    /monitor/,
  );
});

test("CLI prompt files resolve against the config directory from another launch directory", async () => {
  const { writeFile } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "aw-prompt-config-"));
  const launch = await mkdtemp(join(tmpdir(), "aw-prompt-launch-"));
  const promptFile = join(directory, "task.md");
  await writeFile(promptFile, " ");
  const configFile = join(directory, "config.json");
  await writeFile(
    configFile,
    JSON.stringify({
      id: "prompt_file",
      stateDirectory: directory + "-state",
      projects: [
        {
          id: "fixture",
          checkout: directory,
          hosting: {
            provider: "github",
            origin: "https://github.com",
            repository: "a/b",
            tokenEnv: "FILE_PROMPT_TEST_TOKEN",
          },
          agent: { provider: "codex" },
          gitIdentity: { name: "Test", email: "test@example.com" },
          stages: { publication: { promptFile: "task.md" } },
        },
      ],
    }),
  );
  const args = [
    "--import",
    import.meta.resolve("tsx"),
    resolve("src/cli.ts"),
    "--config",
    configFile,
    "run",
  ];
  const options = {
    cwd: launch,
    allowFailure: true,
    env: {
      ...process.env,
      AGENT_WORKFLOWS_DATABASE_URL: "postgresql://localhost/unused",
      FILE_PROMPT_TEST_TOKEN: "",
    },
  };
  const blank = await command(process.execPath, args, options);
  assert.match(blank.stderr, /must be nonblank/);
  assert.ok(blank.stderr.includes(promptFile));
  await writeFile(promptFile, "Custom literal task");
  const loaded = await command(process.execPath, args, options);
  assert.match(
    loaded.stderr,
    /Missing credential environment variable: FILE_PROMPT_TEST_TOKEN/,
  );
});
