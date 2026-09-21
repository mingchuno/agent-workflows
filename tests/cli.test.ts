import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
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
  const generated = configSchema.parse(JSON.parse(original));
  assert.equal(generated.projects.length, 1);
  assert.equal(isAbsolute(generated.stateDirectory), false);
  assert.equal(isAbsolute(generated.projects[0]!.checkout), false);
  assert.equal(
    resolve(dirname(file), generated.projects[0]!.checkout),
    process.cwd(),
  );
  assert.equal(
    resolve(dirname(file), generated.stateDirectory),
    resolve(process.cwd(), "..", `${basename(process.cwd())}.agent-workflows`),
  );
  assert.equal(generated.projects[0]!.includeAgentCoAuthors, true);
  assert.doesNotMatch(original, /gitIdentity/);
  const retry = await command(process.execPath, args, {
    cwd: process.cwd(),
    allowFailure: true,
  });
  assert.equal(retry.exitCode, 1);
  assert.equal(await readFile(file, "utf8"), original);
});

test("CLI config-base override is launch-relative without changing config lookup", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const launch = await mkdtemp(join(tmpdir(), "aw-base-launch-"));
  const configDirectory = join(launch, "configs");
  const base = join(launch, "portable");
  await mkdir(configDirectory);
  await mkdir(join(base, "checkout"), { recursive: true });
  await writeFile(join(base, "prompt.md"), " ");
  const configFile = join(configDirectory, "config.json");
  await writeFile(
    configFile,
    JSON.stringify({
      id: "path_override",
      stateDirectory: "state",
      projects: [
        {
          id: "fixture",
          checkout: "checkout",
          hosting: {
            provider: "github",
            origin: "https://github.com",
            repository: "a/b",
            tokenEnv: "PATH_OVERRIDE_TOKEN",
          },
          agent: { provider: "codex" },
          stages: { publication: { promptFile: "prompt.md" } },
        },
      ],
    }),
  );
  const result = await command(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      resolve("src/cli.ts"),
      "--config",
      relative(launch, configFile),
      "--config-base-directory",
      relative(launch, base),
      "run",
    ],
    {
      cwd: launch,
      allowFailure: true,
      env: {
        ...process.env,
        AGENT_WORKFLOWS_DATABASE_URL: "postgresql://localhost/unused",
        PATH_OVERRIDE_TOKEN: "",
      },
    },
  );
  assert.match(result.stderr, /must be nonblank/);
  assert.ok(result.stderr.includes(join(base, "prompt.md")));
  const invalid = await command(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      resolve("src/cli.ts"),
      "--config",
      relative(launch, configFile),
      "--config-base-directory",
      "missing",
      "run",
    ],
    { cwd: launch, allowFailure: true },
  );
  assert.match(invalid.stderr, /not an existing directory/);
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
  assert.match(
    (
      await command(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "monitor", "--help"],
        { cwd: process.cwd() },
      )
    ).stdout,
    /--notify/,
  );
  const monitor = await command(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "monitor", "--notify"],
    { cwd: process.cwd(), allowFailure: true },
  );
  assert.equal(monitor.exitCode, 1);
  assert.match(monitor.stderr, /requires an interactive terminal/);
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
