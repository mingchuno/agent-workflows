import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { configSchema } from "../src/config.js";
import { command } from "../src/runtime/process.js";

const cliPath = resolve("src/cli.ts");
const databaseUrl = process.env.TEST_DATABASE_URL;
const environment = { PATH: process.env.PATH, HOME: process.env.HOME };
function cli(cwd: string, args: string[], env = environment) {
  return command(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), "--", cliPath, ...args],
    {
      cwd,
      env,
      allowFailure: true,
    },
  );
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aw-env-"));
  const config = configSchema.parse({
    id: "env_" + randomUUID().replaceAll("-", ""),
    stateDirectory: root + "-state",
    projects: [
      {
        id: "test",
        checkout: root,
        hosting: {
          provider: "github",
          origin: "https://github.com",
          repository: "a/b",
          tokenEnv: "GITHUB_TOKEN",
        },
        agent: { provider: "codex" },
        gitIdentity: { name: "Fixture", email: "fixture@example.com" },
      },
    ],
  });
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  return { root, config, configPath };
}

test("CLI advertises the global environment option", async () => {
  const result = await cli(process.cwd(), ["--help"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /--env-file <path>/);
});

test("explicit missing and unreadable environment files fail before init writes anything", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-env-error-"));
  try {
    const denied = join(root, "denied.env");
    await writeFile(denied, "GITHUB_TOKEN=private-fixture-credential\n", {
      mode: 0o000,
    });
    for (const path of [
      join(root, "missing.env"),
      root,
      ...(process.getuid?.() === 0 ? [] : [denied]),
    ]) {
      const result = await cli(root, ["--env-file", path, "init"]);
      assert.equal(result.exitCode, 1, result.stderr);
      assert.match(result.stderr, /Cannot read environment file/);
      assert.doesNotMatch(result.stderr, /private-fixture-credential/);
      await assert.rejects(readFile(join(root, "agent-workflows.json")), {
        code: "ENOENT",
      });
    }
    await chmod(denied, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("without the option CLI does not discover .env; empty shell values still fail required validation", async () => {
  const { root, configPath } = await fixture();
  try {
    await writeFile(
      join(root, ".env"),
      "AGENT_WORKFLOWS_DATABASE_URL=postgresql://fixture:private-password@localhost/db\n",
    );
    for (const args of [[], ["--env-file", ".env"]]) {
      const result = await cli(
        root,
        [...args, "--config", configPath, "status", "--json"],
        {
          ...environment,
          ...(args.length ? { AGENT_WORKFLOWS_DATABASE_URL: "" } : {}),
        },
      );
      assert.equal(result.exitCode, 1, result.stderr);
      assert.match(result.stderr, /Set AGENT_WORKFLOWS_DATABASE_URL/);
      assert.doesNotMatch(result.stderr, /private-password/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the environment option is global and fails before every command action", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-env-commands-"));
  try {
    for (const args of [
      ["run"],
      ["status"],
      ["inspect", "run-id"],
      ["logs", "run-id"],
      ["pause", "project"],
      ["resume", "project"],
      ["stop", "run-id"],
      ["retry", "run-id"],
      ["monitor"],
    ]) {
      const result = await cli(root, [...args, "--env-file", "missing.env"]);
      assert.equal(result.exitCode, 1, result.stderr);
      assert.match(result.stderr, /Cannot read environment file.*ENOENT/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("empty default and custom hosting credentials are not replaced by file values", async () => {
  const { root, config, configPath } = await fixture();
  try {
    for (const tokenEnv of ["GITHUB_TOKEN", "CUSTOM_CREDENTIAL"]) {
      config.projects[0]!.hosting.tokenEnv = tokenEnv;
      await writeFile(configPath, JSON.stringify(config));
      await writeFile(
        join(root, "runner.env"),
        `AGENT_WORKFLOWS_DATABASE_URL=postgresql://fixture:dummy-password@localhost/unused\n${tokenEnv}=dummy-file-token\n`,
      );
      const result = await cli(
        root,
        ["--config", configPath, "--env-file", "runner.env", "run"],
        { ...environment, [tokenEnv]: "" },
      );
      assert.equal(result.exitCode, 1, result.stderr);
      assert.match(
        result.stderr,
        new RegExp(`Missing credential environment variable: ${tokenEnv}`),
      );
      assert.doesNotMatch(result.stderr, /dummy-password|dummy-file-token/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("store commands load default and custom database variables from launch-relative and absolute files", {
  skip: !databaseUrl,
}, async () => {
  const { root, config, configPath } = await fixture();
  const launch = await mkdtemp(join(tmpdir(), "aw-env-launch-"));
  try {
    for (const name of ["AGENT_WORKFLOWS_DATABASE_URL", "CUSTOM_CONNECTION"]) {
      config.databaseUrlEnv = name;
      await writeFile(configPath, JSON.stringify(config));
      await writeFile(
        join(launch, "settings.env"),
        `${name}='${databaseUrl}' # connection\n`,
      );
      await writeFile(join(root, "settings.env"), `${name}=wrong-directory\n`);
      for (const path of ["settings.env", join(launch, "settings.env")]) {
        const result = await cli(launch, [
          "status",
          "--json",
          "--config",
          configPath,
          "--env-file",
          path,
        ]);
        assert.equal(result.exitCode, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {
          projects: [],
          runs: [],
          commands: [],
        });
      }
      await writeFile(
        join(launch, "settings.env"),
        `${name}=invalid-file-connection\n`,
      );
      const result = await cli(
        launch,
        [
          "--env-file",
          "settings.env",
          "--config",
          configPath,
          "status",
          "--json",
        ],
        { ...environment, [name]: databaseUrl },
      );
      assert.equal(result.exitCode, 0, result.stderr);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(launch, { recursive: true, force: true });
  }
});

test("runner workers and validation inherit literal startup values and retain credential redaction", {
  skip: !databaseUrl,
}, async () => {
  const { once } = await import("node:events");
  const { createServer } = await import("node:http");
  const { spawn } = await import("node:child_process");
  const { repository } = await import("./fixtures.js");
  const { waitFor } = await import("./runner-fixtures.js");
  const { Store } = await import("../src/store.js");
  for (const tokenEnv of ["GITHUB_TOKEN", "CUSTOM_CREDENTIAL"]) {
    const { root, project } = await repository();
    const directory = await mkdtemp(join(tmpdir(), "aw-env-runner-"));
    const token = "dummy-environment-file-credential";
    const authorizations: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      authorizations.push(request.headers.authorization);
      response.setHeader("content-type", "application/json");
      const issue = {
        id: 1,
        number: 1,
        title: "Fixture",
        body: "Implement task",
        html_url: "https://fixture.invalid/1",
        labels: [{ name: "ready-for-agent" }],
        state: "open",
      };
      response.end(
        JSON.stringify(request.url?.includes("/issues/1") ? issue : [issue]),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    project.hosting.origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    project.hosting.tokenEnv = tokenEnv;
    project.validation = [
      {
        command: process.execPath,
        args: [resolve("tests/fixtures/env-child.mjs"), "validation"],
        timeoutMs: 10000,
      },
    ];
    const config = configSchema.parse({
      id: "inherit_" + randomUUID().replaceAll("-", ""),
      stateDirectory: join(directory, "state"),
      projects: [project],
    });
    if (tokenEnv === "CUSTOM_CREDENTIAL")
      config.databaseUrlEnv = "CUSTOM_CONNECTION";
    const configPath = join(directory, "config.json");
    await writeFile(configPath, JSON.stringify(config));
    const { envPath, marker, expected } = await workflowEnvironment(
      directory,
      databaseUrl!,
      config.databaseUrlEnv,
      tokenEnv,
    );
    const child = spawn(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        "--",
        cliPath,
        "--config",
        configPath,
        "--env-file",
        envPath,
        "run",
      ],
      {
        cwd: directory,
        env: workerEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const closed = once(child, "close");
    const store = new Store(databaseUrl!, config.id);
    try {
      await store.initialize();
      await waitFor(async () => {
        assert.equal(child.exitCode, null, output);
        return (await store.runs()).some((run) => run.outcome === "failed");
      });
      for (const stage of ["implementation", "validation", "publication"]) {
        assert.deepEqual(
          JSON.parse(await readFile(join(directory, `${stage}.json`), "utf8")),
          expected,
        );
      }
      assert.ok(authorizations.length > 0);
      assert.ok(authorizations.every((value) => value === `token ${token}`));
      await assert.rejects(readFile(marker), { code: "ENOENT" });
      assert.match(await readFile(envPath, "utf8"), /edited-after-startup/);
      const run = (await store.runs())[0]!;
      const invocations = await store.invocations(run.id);
      const artifacts = await Promise.all(
        [
          ...invocations.map((item) => item.log),
          ...run.validation!.map((item) => item.log),
        ].map((path) => readFile(path, "utf8")),
      );
      const diagnostic = output + JSON.stringify(run) + artifacts.join("\n");
      assert.ok(!diagnostic.includes(token));
      assert.ok(!diagnostic.includes(databaseUrl!));
      assert.match(diagnostic, /\[REDACTED\]/);
    } finally {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      await closed;
      clearTimeout(timer);
      await store.close();
      server.close();
      await once(server, "close");
      await rm(directory, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
      await rm(root + "-remote", { recursive: true, force: true });
    }
  }
});

async function workflowEnvironment(
  directory: string,
  url: string,
  databaseEnv = "AGENT_WORKFLOWS_DATABASE_URL",
  tokenEnv = "GITHUB_TOKEN",
) {
  const token = "dummy-environment-file-credential";
  const envPath = join(directory, "runner.env");
  const executable = join(directory, "codex.mjs");
  await copyFile(resolve("tests/fixtures/env-codex.mjs"), executable);
  await copyFile(
    resolve("tests/fixtures/env-child.mjs"),
    join(directory, "env-child.mjs"),
  );
  await chmod(executable, 0o700);
  const marker = join(directory, "should-not-exist");
  const expected = {
    [databaseEnv]: url,
    [tokenEnv]: token,
    APP_GREETING: "hello # literal world",
    APP_REFERENCE: `\${APP_GREETING}/$APP_GREETING`,
    APP_COMMAND: `$(touch ${marker})`,
    APP_BACKTICKS: `\`touch ${marker}\``,
    APP_OVERRIDE: "from-shell",
    APP_EMPTY: "",
  };
  await writeFile(
    envPath,
    [
      "# Literal assignments for the whole runner",
      `${databaseEnv}='${url}'`,
      `${tokenEnv}=${token} # comment`,
      'APP_GREETING="hello # literal world"',
      `APP_REFERENCE='\${APP_GREETING}/$APP_GREETING'`,
      `APP_COMMAND='$(touch ${marker})'`,
      `APP_BACKTICKS='\`touch ${marker}\`'`,
      "APP_OVERRIDE=from-file",
      "APP_EMPTY=from-file",
      `AW_TEST_OUTPUT=${directory}`,
      `AW_TEST_ENV_FILE=${envPath}`,
      `AW_TEST_CODEX=${executable}`,
    ].join("\n"),
  );
  return { envPath, marker, expected };
}
const workerEnvironment = {
  ...environment,
  APP_OVERRIDE: "from-shell",
  APP_EMPTY: "",
  NODE_OPTIONS: `--import=${resolve("tests/fixtures/env-agent-loader.mjs")}`,
};

test("CLI startup feeds literal values to SDK workers and later children without reloading", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aw-env-children-"));
  try {
    const { expected, marker } = await workflowEnvironment(
      directory,
      "postgresql://fixture:dummy-password@localhost/unused",
    );
    const result = await command(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        "--",
        resolve("tests/env-cli-worker.ts"),
        "--env-file",
        "runner.env",
        "init",
      ],
      { cwd: directory, env: workerEnvironment, allowFailure: true },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    for (const stage of ["implementation", "validation", "publication"]) {
      assert.deepEqual(
        JSON.parse(await readFile(join(directory, `${stage}.json`), "utf8")),
        expected,
      );
    }
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    const scaffold = await readFile(
      join(directory, "agent-workflows.json"),
      "utf8",
    );
    assert.ok(!scaffold.includes(expected.GITHUB_TOKEN!));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
