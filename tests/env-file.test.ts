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
      },
    ],
  });
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  return { root, config, configPath };
}

test("CLI removes the environment option", async () => {
  const result = await cli(process.cwd(), ["--help"]);
  assert.equal(result.exitCode, 0);
  assert.doesNotMatch(result.stdout, /--env-file/);
  const legacy = await cli(process.cwd(), ["--env-file", ".env", "init"]);
  assert.equal(legacy.exitCode, 1);
  assert.match(legacy.stderr, /unknown option '--env-file'/);
});

test("configured missing and unreadable environment files fail safely", async () => {
  const { root, config, configPath } = await fixture();
  try {
    assert.equal(
      configSchema.safeParse({ ...config, envFile: "runner.env" }).success,
      false,
    );
    const denied = join(root, "denied.env");
    await writeFile(denied, "GITHUB_TOKEN=private-fixture-credential\n", {
      mode: 0o000,
    });
    for (const path of [
      join(root, "missing.env"),
      root,
      ...(process.getuid?.() === 0 ? [] : [denied]),
    ]) {
      await writeFile(configPath, JSON.stringify({ ...config, envFile: path }));
      const result = await cli(root, [
        "--config",
        configPath,
        "status",
        "--json",
      ]);
      assert.equal(result.exitCode, 1, result.stderr);
      assert.match(result.stderr, /Cannot read environment file/);
      assert.doesNotMatch(result.stderr, /private-fixture-credential/);
    }
    await chmod(denied, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("envFile must be a nonblank path", async () => {
  const { root, config, configPath } = await fixture();
  try {
    await writeFile(configPath, JSON.stringify({ ...config, envFile: " " }));
    const result = await cli(root, [
      "--config",
      configPath,
      "status",
      "--json",
    ]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Environment file path must be nonblank/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("omitted envFile disables discovery and existing empty values still win", async () => {
  const { root, config, configPath } = await fixture();
  try {
    await writeFile(
      join(root, ".env"),
      "AGENT_WORKFLOWS_DATABASE_URL=postgresql://fixture:private-password@localhost/db\n",
    );
    for (const configured of [false, true]) {
      await writeFile(
        configPath,
        JSON.stringify({ ...config, ...(configured && { envFile: ".env" }) }),
      );
      const result = await cli(
        root,
        ["--config", configPath, "status", "--json"],
        {
          ...environment,
          ...(configured ? { AGENT_WORKFLOWS_DATABASE_URL: "" } : {}),
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

test("configured envFile loads before every configuration-consuming command", async () => {
  const { root, config, configPath } = await fixture();
  try {
    await writeFile(
      configPath,
      JSON.stringify({ ...config, envFile: "missing.env" }),
    );
    for (const args of [
      ["run"],
      ["status"],
      ["inspect", "run-id"],
      ["logs", "run-id"],
      ["pause", "project"],
      ["resume", "project"],
      ["stop", "run-id"],
      ["retry", "run-id"],
      ["recover", "run-id"],
      ["monitor"],
    ]) {
      const result = await cli(root, ["--config", configPath, ...args]);
      assert.equal(result.exitCode, 1, result.stderr);
      assert.match(result.stderr, /Cannot read environment file.*ENOENT/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("relative and absolute files do not replace empty hosting credentials", async () => {
  const { root, config, configPath } = await fixture();
  try {
    for (const tokenEnv of ["GITHUB_TOKEN", "CUSTOM_CREDENTIAL"]) {
      config.projects[0]!.hosting.tokenEnv = tokenEnv;
      const envFile =
        tokenEnv === "GITHUB_TOKEN" ? "runner.env" : join(root, "runner.env");
      await writeFile(configPath, JSON.stringify({ ...config, envFile }));
      await writeFile(
        join(root, "runner.env"),
        `AGENT_WORKFLOWS_DATABASE_URL=postgresql://fixture:dummy-password@localhost/unused\n${tokenEnv}=dummy-file-token\n`,
      );
      const result = await cli(root, ["--config", configPath, "run"], {
        ...environment,
        [tokenEnv]: "",
      });
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

test("store commands load default and custom database variables from config-relative and absolute files", {
  skip: !databaseUrl,
}, async () => {
  const { root, config, configPath } = await fixture();
  const launch = await mkdtemp(join(tmpdir(), "aw-env-launch-"));
  try {
    for (const name of ["AGENT_WORKFLOWS_DATABASE_URL", "CUSTOM_CONNECTION"]) {
      config.databaseUrlEnv = name;
      await writeFile(
        join(launch, "settings.env"),
        `${name}=wrong-launch-directory\n`,
      );
      await writeFile(
        join(root, "settings.env"),
        `${name}='${databaseUrl}' # connection\n`,
      );
      for (const path of ["settings.env", join(root, "settings.env")]) {
        await writeFile(
          configPath,
          JSON.stringify({ ...config, envFile: path }),
        );
        const result = await cli(launch, [
          "status",
          "--json",
          "--config",
          configPath,
        ]);
        assert.equal(result.exitCode, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {
          projects: [],
          runs: [],
          commands: [],
        });
      }
      await writeFile(
        join(root, "settings.env"),
        `${name}=invalid-file-connection\n`,
      );
      await writeFile(
        configPath,
        JSON.stringify({ ...config, envFile: "settings.env" }),
      );
      const result = await cli(
        launch,
        ["--config", configPath, "status", "--json"],
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
    const { envPath, marker, expected } = await workflowEnvironment(
      directory,
      databaseUrl!,
      config.databaseUrlEnv,
      tokenEnv,
    );
    await writeFile(
      configPath,
      JSON.stringify({ ...config, envFile: envPath }),
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
