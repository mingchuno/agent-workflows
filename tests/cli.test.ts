import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
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
import { Store } from "../src/store.js";
import { repository } from "./fixtures.js";
import { waitFor } from "./runner-fixtures.js";

test("CLI reload targets its original server despite invalid JSON and preserves startup path/project selection", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const { project } = await repository();
  const directory = await mkdtemp(join(tmpdir(), "aw-cli-reload-"));
  const base = join(directory, "base");
  const configs = join(directory, "configs");
  await mkdir(base);
  await mkdir(configs);
  const scans: string[] = [];
  let holdScans = false;
  const heldResponses: ServerResponse[] = [];
  const server = createServer((request, response) => {
    scans.push(request.url!);
    response.setHeader("content-type", "application/json");
    if (holdScans) heldResponses.push(response);
    else response.end("[]");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address() as { port: number };
  project.hosting.origin = `http://127.0.0.1:${address.port}`;
  project.workflows.implementation.enabled = false;
  project.checkout = relative(base, project.checkout);
  const config = configSchema.parse({
    id: "cli_reload_" + randomUUID().replaceAll("-", ""),
    stateDirectory: "state",
    projects: [
      project,
      { ...project, id: "unselected", checkout: "missing-checkout" },
    ],
  });
  const configPath = join(configs, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({ ...config, envFile: "runner.env" }),
  );
  await writeFile(
    join(base, "runner.env"),
    `AGENT_WORKFLOWS_DATABASE_URL=${process.env.TEST_DATABASE_URL}\nFIXTURE_TOKEN=fixture-token\n`,
  );
  await writeFile(
    join(base, "instructions.md"),
    "Reloaded relative instructions",
  );
  const args = [
    "--import",
    import.meta.resolve("tsx"),
    resolve("src/cli.ts"),
    "--config",
    configPath,
  ];
  const env = {
    ...process.env,
    AGENT_WORKFLOWS_DATABASE_URL: undefined,
    FIXTURE_TOKEN: undefined,
  };
  const crashed = await command(
    process.execPath,
    [
      "--import",
      resolve("tests/fixtures/cli-control-fault-loader.mjs"),
      ...args,
      "--config-base-directory",
      base,
      "run",
      "--project",
      "fixture",
    ],
    { cwd: directory, env, allowFailure: true },
  );
  assert.equal(crashed.exitCode, 77, crashed.stderr);
  const abort = new AbortController();
  let output = "";
  let ended = false;
  const running = command(
    process.execPath,
    [...args, "--config-base-directory", base, "run", "--project", "fixture"],
    {
      cwd: directory,
      env,
      signal: abort.signal,
      onOutput: (chunk) => {
        output += chunk;
      },
    },
  ).then(
    (result) => {
      ended = true;
      return result.stderr;
    },
    (error) => {
      ended = true;
      return String(error);
    },
  );
  const store = new Store(process.env.TEST_DATABASE_URL!, config.id);
  try {
    await waitFor(async () => {
      if (ended) throw new Error(`Runner exited: ${output}\n${await running}`);
      return output.includes("started");
    });
    await store.initialize();
    const reload = () =>
      command(process.execPath, [...args, "reload"], {
        cwd: directory,
        env,
        allowFailure: true,
      });
    await writeFile(configPath, "{invalid JSON");
    const invalid = await reload();
    assert.equal(invalid.exitCode, 1);
    assert.match(invalid.stdout, /"status":"failed"/);
    await writeFile(
      configPath,
      JSON.stringify({ ...config, id: "other", envFile: "runner.env" }),
    );
    const identity = await reload();
    assert.equal(identity.exitCode, 1);
    assert.match(identity.stdout, /require restart: id/);
    await writeFile(
      configPath,
      JSON.stringify({ ...config, envFile: "missing.env" }),
    );
    const environment = await reload();
    assert.equal(environment.exitCode, 1);
    assert.match(environment.stdout, /require restart: envFile/);
    config.projects[0]!.workflows.implementation.enabled = true;
    config.projects[0]!.workflows.implementation.labels = ["reloaded-label"];
    config.projects[0]!.pollIntervalMs = 100;
    config.projects[0]!.stages.implementation.promptFile = "instructions.md";
    await writeFile(
      configPath,
      JSON.stringify({ ...config, envFile: "runner.env" }),
    );
    const success = await reload();
    assert.equal(success.exitCode, 0, success.stderr);
    assert.match(success.stdout, /"status":"pending"/);
    assert.match(success.stdout, /"status":"success"/);
    await waitFor(async () =>
      scans.some((url) => url.includes("labels=reloaded-label")),
    );
    assert.deepEqual(
      (await store.projects()).map((item) => item.id),
      ["fixture"],
    );
    holdScans = true;
    await waitFor(async () => heldResponses.length > 0);
    const timedOut = await command(
      process.execPath,
      [...args, "reload", "--timeout-ms", "100"],
      {
        cwd: directory,
        env,
        allowFailure: true,
      },
    );
    assert.equal(timedOut.exitCode, 1);
    assert.match(timedOut.stderr, /still pending; timeout does not cancel it/);
    const pendingId = JSON.parse(timedOut.stdout.trim()).commandId as string;
    assert.equal(
      (await store.commands()).find((item) => item.id === pendingId)!.status,
      "pending",
    );
    holdScans = false;
    for (const response of heldResponses) response.end("[]");
    await waitFor(
      async () =>
        (await store.commands()).find((item) => item.id === pendingId)
          ?.status === "success",
    );
    const wrongConnection = await command(
      process.execPath,
      [...args, "reload"],
      {
        cwd: directory,
        env: {
          ...env,
          AGENT_WORKFLOWS_DATABASE_URL: "postgresql://localhost/different",
        },
        allowFailure: true,
      },
    );
    assert.match(wrongConnection.stderr, /Database connection differs/);
  } finally {
    holdScans = false;
    for (const response of heldResponses) response.end("[]");
    abort.abort();
    await running;
    await store.close();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    await rm(directory, { recursive: true, force: true });
  }
  const offline = await command(process.execPath, [...args, "reload"], {
    cwd: process.cwd(),
    env,
    allowFailure: true,
  });
  assert.equal(offline.exitCode, 1);
  assert.match(offline.stderr, /No active runner control record/);
});

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
  assert.doesNotMatch(original, /"envFile"/);
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
  await writeFile(
    join(base, "runner.env"),
    "AGENT_WORKFLOWS_DATABASE_URL=postgresql://localhost/unused\n",
  );
  const configFile = join(configDirectory, "config.json");
  await writeFile(
    configFile,
    JSON.stringify({
      id: "path_override",
      envFile: "runner.env",
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
        AGENT_WORKFLOWS_DATABASE_URL: undefined,
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
  const monitorDirectory = await mkdtemp(join(tmpdir(), "aw-monitor-"));
  const monitorConfig = join(monitorDirectory, "config.json");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    monitorConfig,
    JSON.stringify({
      id: "monitor",
      projects: [
        {
          id: "fixture",
          checkout: monitorDirectory,
          hosting: {
            provider: "github",
            origin: "https://github.com",
            repository: "a/b",
            tokenEnv: "MONITOR_TOKEN",
          },
          agent: { provider: "codex" },
        },
      ],
    }),
  );
  const monitor = await command(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/cli.ts",
      "--config",
      monitorConfig,
      "monitor",
      "--notify",
    ],
    { cwd: process.cwd(), allowFailure: true },
  );
  assert.equal(monitor.exitCode, 1);
  assert.match(monitor.stderr, /requires an interactive terminal/);
  await rm(monitorDirectory, { recursive: true, force: true });
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
