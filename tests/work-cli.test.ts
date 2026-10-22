import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { command } from "../packages/core/src/runtime/process.js";
import { Store } from "../packages/core/src/store.js";
import { workContractSchema } from "../packages/core/src/work/schema.js";
import { repository } from "./fixtures.js";

test("public work CLI resumes persisted scope approval and deduplicates submission", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "aw-work-cli-"));
  const { root } = await repository();
  const scope = randomUUID();
  const configPath = join(directory, "config.json");
  const file = join(directory, "contract.json");
  const contract = workContractSchema.parse({
    title: "Sort missing sizes",
    intent: "Missing sizes sort last",
    acceptanceCriteria: ["Missing sizes appear after numerical sizes"],
    scopePaths: ["src/**"],
    verification: { strategy: "Sorting regression test" },
    assessment: { proposedTrack: "B", complexity: "small" },
  });
  await writeFile(file, JSON.stringify(contract));
  await writeFile(
    configPath,
    JSON.stringify({
      id: scope.replaceAll("-", ""),
      stateDirectory: `../${basename(root)}-state`,
      projects: [
        {
          id: "app",
          checkout: ".",
          hosting: {
            provider: "github",
            origin: "https://github.com",
            repository: "fixture/fixture",
            tokenEnv: "UNUSED_TOKEN",
          },
          agent: { provider: "codex" },
          sdlc: { enabled: true },
        },
      ],
    }),
  );
  const cli = async (...args: string[]) =>
    command(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        fileURLToPath(new URL("../packages/cli/src/cli.ts", import.meta.url)),
        "--config",
        configPath,
        "--config-base-directory",
        root,
        "work",
        ...args,
        "--project",
        "app",
        "--json",
      ],
      {
        cwd: tmpdir(),
        env: {
          ...process.env,
          AGENT_WORKFLOWS_DATABASE_URL: process.env.TEST_DATABASE_URL,
        },
        timeoutMs: 20000,
        allowFailure: true,
      },
    );
  const created = JSON.parse(
    (await cli("create", "--file", file, "--key", "sort-missing")).stdout,
  );
  assert.equal(created.decision.state, "awaiting-scope-approval");
  const id = created.work.id as string;
  const revision = created.work.revision as string;
  assert.equal(
    JSON.parse(
      (await cli("create", "--file", file, "--key", "sort-missing")).stdout,
    ).work.id,
    id,
  );
  const blocked = await cli("submit", id, "--revision", revision);
  assert.equal(blocked.exitCode, 1);
  assert.match(blocked.stderr, /scope approval/);
  const approved = await cli(
    "approve",
    id,
    "--revision",
    revision,
    "--gate",
    "scope",
  );
  assert.equal(approved.exitCode, 0, approved.stderr);
  assert.equal(JSON.parse(approved.stdout).decision.state, "ready");
  assert.equal(
    JSON.parse((await cli("inspect", id)).stdout).decision.state,
    "ready",
  );
  const run = JSON.parse(
    (await cli("submit", id, "--revision", revision)).stdout,
  ).run;
  const replay = JSON.parse(
    (await cli("submit", id, "--revision", revision)).stdout,
  ).run;
  assert.equal(run.id, replay.id);
  assert.equal(run.subject.kind, "local");
  assert.equal(run.checkout, await realpath(root));
  const store = new Store(
    process.env.TEST_DATABASE_URL!,
    scope.replaceAll("-", ""),
  );
  try {
    assert.equal((await store.runs()).length, 1);
    await store.patchRun(run.id, { outcome: "blocked" });
    await store.blockProject("app", "Scope needs reassessment");
    await writeFile(
      file,
      JSON.stringify({
        ...contract,
        acceptanceCriteria: ["Missing sizes are last in both directions"],
      }),
    );
    const revised = JSON.parse(
      (await cli("propose", id, "--revision", revision, "--file", file)).stdout,
    ).work;
    assert.equal(
      (
        await cli(
          "approve",
          id,
          "--revision",
          revised.revision,
          "--gate",
          "scope",
        )
      ).exitCode,
      0,
    );
    assert.equal(
      (await cli("submit", id, "--revision", revised.revision)).exitCode,
      1,
    );
    const recovered = await cli(
      "submit",
      id,
      "--revision",
      revised.revision,
      "--recover",
    );
    assert.equal(recovered.exitCode, 0, recovered.stderr);
    assert.equal(JSON.parse(recovered.stdout).run.attempt, 2);
    assert.equal((await store.project("app")).blocked, null);
  } finally {
    await store.close();
  }
});

async function cliFixture(
  sdlc: Record<string, unknown>,
  origin = "https://github.com",
) {
  const directory = await mkdtemp(join(tmpdir(), "aw-cli-fixture-"));
  const { root } = await repository();
  const configPath = join(directory, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      id: randomUUID().replaceAll("-", ""),
      stateDirectory: `../${basename(root)}-state`,
      projects: [
        {
          id: "app",
          checkout: ".",
          hosting: {
            provider: "github",
            origin,
            repository: "fixture/fixture",
            tokenEnv: "FIXTURE_HOST_TOKEN",
          },
          agent: { provider: "codex" },
          sdlc,
        },
      ],
    }),
  );
  const cli = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) =>
    command(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        fileURLToPath(new URL("../packages/cli/src/cli.ts", import.meta.url)),
        "--config-base-directory",
        root,
        ...args,
      ],
      {
        cwd,
        env: { ...process.env, AGENT_WORKFLOWS_CONFIG: configPath, ...env },
        timeoutMs: 20000,
        allowFailure: true,
      },
    );
  return { directory, root, cli };
}

test("work classify routes Track A inline and escalates an oversized diff without a database", async () => {
  const { directory, root, cli } = await cliFixture({
    fastTrackMaxFiles: 2,
    riskRules: [{ paths: ["db/**"], minimumTrack: "C" }],
  });
  const file = join(directory, "contract.json");
  await writeFile(
    file,
    JSON.stringify({
      title: "Fix sorting",
      intent: "Missing sizes sort last",
      acceptanceCriteria: ["Missing sizes sort last"],
      assessment: { proposedTrack: "A", complexity: "small" },
    }),
  );
  const env = { AGENT_WORKFLOWS_DATABASE_URL: "" };
  const classify = async (...extra: string[]) => {
    const result = await cli(
      root,
      env,
      "work",
      "classify",
      "--project",
      "app",
      "--file",
      file,
      ...extra,
    );
    assert.equal(result.exitCode, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const before = await classify();
  assert.equal(before.track, "A");
  assert.equal(before.protocol, "inline");
  assert.deepEqual(before.missing, []);
  for (const name of ["a.txt", "b.txt", "c.txt"])
    await writeFile(join(root, name), "changed\n");
  const after = await classify("--changed-from", "HEAD");
  assert.deepEqual(after.changedPaths, ["a.txt", "b.txt", "c.txt"]);
  assert.ok(
    after.escalation.some(
      (reason: { code: string }) => reason.code === "track-escalation",
    ),
  );
});

test("doctor reports missing setup and still allows the inline protocol", async () => {
  const outside = await mkdtemp(join(tmpdir(), "aw-doctor-"));
  const { cli } = await cliFixture({ enabled: true });
  const env = { AGENT_WORKFLOWS_CONFIG: join(outside, "missing.json") };
  const readable = await cli(outside, env, "doctor");
  assert.equal(readable.exitCode, 1);
  assert.match(readable.stdout, /✗ configuration/);
  assert.match(readable.stdout, /agent-workflows init/);
  assert.match(readable.stdout, /Track A work runs inline without setup/);
  const result = await cli(outside, env, "doctor", "--json");
  assert.equal(result.exitCode, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.deepEqual(report.protocols, { inline: true, delegated: false });
  assert.equal(report.checks[0].name, "configuration");
  assert.equal(report.checks[0].status, "fail");
});

test("doctor resolves the project from the working directory and checks the database", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const authorizations: string[] = [];
  const server = createServer((request, response) => {
    authorizations.push(String(request.headers.authorization));
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/v3/repos/fixture/fixture")
      return response.end(JSON.stringify({ full_name: "fixture/fixture" }));
    response.statusCode = 404;
    response.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  const { root, cli } = await cliFixture(
    { enabled: true },
    `http://127.0.0.1:${port}`,
  );
  const result = await cli(
    root,
    {
      AGENT_WORKFLOWS_DATABASE_URL: process.env.TEST_DATABASE_URL,
      FIXTURE_HOST_TOKEN: "fixture-token",
      CODEX_HOME: await mkdtemp(join(tmpdir(), "aw-codex-")),
      CODEX_API_KEY: "",
      OPENAI_API_KEY: "",
    },
    "doctor",
    "--json",
  ).finally(() => server.close());
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.project, "app");
  assert.deepEqual(report.protocols, { inline: true, delegated: true });
  assert.deepEqual(
    Object.fromEntries(
      report.checks.map((item: { name: string; status: string }) => [
        item.name,
        item.status,
      ]),
    ),
    {
      configuration: "pass",
      project: "pass",
      repository: "pass",
      sdlc: "pass",
      "hosting-credentials": "pass",
      "hosting-access": "pass",
      agent: "warn",
      validation: "warn",
      database: "pass",
      worker: "warn",
    },
  );
  assert.deepEqual(authorizations, ["Bearer fixture-token"]);
  assert.doesNotMatch(result.stdout, /fixture-token/);
});

test("doctor discovers the configuration that manages a linked worktree", async () => {
  const { root, git } = await repository();
  const home = await mkdtemp(join(tmpdir(), "aw-config-home-"));
  const worktree = `${root}-worktree`;
  await git("worktree", "add", "-b", "session", worktree);
  const write = (name: string, id: string) =>
    writeFile(
      join(home, name),
      JSON.stringify({
        id,
        stateDirectory: `${root}-state-${id}`,
        projects: [
          {
            id: "app",
            checkout: root,
            hosting: {
              provider: "github",
              origin: "https://github.com",
              repository: "fixture/fixture",
              tokenEnv: "FIXTURE_HOST_TOKEN",
            },
            agent: { provider: "codex" },
            sdlc: { enabled: true },
          },
        ],
      }),
    );
  await write("app.json", "app");
  await writeFile(join(home, "notes.json"), "not configuration");
  const doctor = () =>
    command(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        fileURLToPath(new URL("../packages/cli/src/cli.ts", import.meta.url)),
        "doctor",
        "--json",
      ],
      {
        cwd: worktree,
        env: {
          ...process.env,
          AGENT_WORKFLOWS_CONFIG: "",
          AGENT_WORKFLOWS_HOME: home,
          AGENT_WORKFLOWS_DATABASE_URL: "",
        },
        timeoutMs: 20000,
        allowFailure: true,
      },
    );
  const found = JSON.parse((await doctor()).stdout);
  assert.equal(found.configPath, join(home, "app.json"));
  assert.equal(found.project, "app");
  assert.equal(found.checks[0].status, "pass");

  await write("other.json", "other");
  const ambiguous = JSON.parse((await doctor()).stdout);
  assert.equal(ambiguous.checks[0].name, "configuration");
  assert.equal(ambiguous.checks[0].status, "fail");
  assert.match(ambiguous.checks[0].detail, /Several configurations/);
});

test("work publish creates one GitHub issue for local work and rebinds it", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const issues: Array<Record<string, unknown>> = [];
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const url = new URL(request.url!, "http://127.0.0.1");
    requests.push(`${request.method} ${url.pathname}`);
    response.setHeader("content-type", "application/json");
    const path = "/api/v3/repos/fixture/fixture/issues";
    if (request.method === "GET" && url.pathname === path)
      return response.end(JSON.stringify(issues));
    if (request.method === "POST" && url.pathname === path) {
      const input = JSON.parse(text);
      const issue = {
        id: 900 + issues.length,
        number: issues.length + 1,
        title: input.title,
        body: input.body,
        html_url: `https://github.test/fixture/fixture/issues/${issues.length + 1}`,
        labels: [],
        state: "open",
      };
      issues.push(issue);
      response.statusCode = 201;
      return response.end(JSON.stringify(issue));
    }
    const issue = issues.find(
      (item) => `${path}/${item.number}` === url.pathname,
    );
    if (issue && request.method === "PATCH")
      Object.assign(issue, JSON.parse(text));
    response.statusCode = issue ? 200 : 404;
    response.end(JSON.stringify(issue ?? { message: "Not Found" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  try {
    const { directory, root, cli } = await cliFixture(
      { enabled: true },
      `http://127.0.0.1:${port}`,
    );
    const file = join(directory, "contract.json");
    const contract = {
      title: "Retry webhooks",
      context: "Deliveries are lost after transient failures.",
      intent: "Retry transient webhook failures",
      acceptanceCriteria: ["Transient failures retry with bounded backoff"],
      scopePaths: ["src/**"],
      verification: { strategy: "Retry policy tests" },
      assessment: { proposedTrack: "B", complexity: "moderate" },
    };
    await writeFile(file, JSON.stringify(contract));
    const env = {
      AGENT_WORKFLOWS_DATABASE_URL: process.env.TEST_DATABASE_URL,
      FIXTURE_HOST_TOKEN: "fixture-token",
    };
    const work = (...args: string[]) =>
      cli(root, env, "work", ...args, "--project", "app");
    const created = JSON.parse(
      (await work("create", "--file", file, "--key", "webhooks")).stdout,
    );
    const id = created.work.id as string;
    const published = await work(
      "publish",
      id,
      "--revision",
      created.work.revision,
    );
    assert.equal(published.exitCode, 0, published.stderr);
    const result = JSON.parse(published.stdout);
    assert.equal(result.work.source.kind, "github");
    assert.equal(result.work.source.number, 1);
    assert.equal(
      result.work.contract.sourceRevision,
      result.work.source.revision,
    );
    assert.equal(result.decision.state, "awaiting-scope-approval");
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.title, "Retry webhooks");
    assert.match(String(issues[0]!.body), /Deliveries are lost/);
    assert.match(
      String(issues[0]!.body),
      new RegExp(`agent-workflows:contract:${id}`),
    );
    const replay = await work(
      "publish",
      id,
      "--revision",
      result.work.revision,
    );
    assert.equal(replay.exitCode, 0, replay.stderr);
    assert.equal(JSON.parse(replay.stdout).work.revision, result.work.revision);
    assert.equal(issues.length, 1);
    assert.equal(
      requests.filter((request) => request.startsWith("PATCH")).length,
      0,
    );
    const intake = JSON.parse((await work("create", "--issue", "1")).stdout);
    assert.equal(intake.work.id, id);

    // From the checkout, the project is implied and a proposal can republish.
    await writeFile(
      file,
      JSON.stringify({
        ...contract,
        acceptanceCriteria: ["Retries stop after five attempts"],
      }),
    );
    const republished = await cli(
      root,
      env,
      "work",
      "propose",
      id,
      "--revision",
      result.work.revision,
      "--file",
      file,
      "--publish",
    );
    assert.equal(republished.exitCode, 0, republished.stderr);
    assert.equal(republished.stdout.trim().split("\n").length, 1);
    assert.match(String(issues[0]!.body), /Retries stop after five attempts/);
    const brief = JSON.parse(
      (await cli(root, env, "work", "list", "--brief")).stdout,
    );
    assert.deepEqual(brief, [
      {
        id,
        title: "Retry webhooks",
        source: "https://github.test/fixture/fixture/issues/1",
        track: "B",
        state: "awaiting-scope-approval",
      },
    ]);
  } finally {
    server.close();
    await once(server, "close");
  }
});

const cliPath = fileURLToPath(
  new URL("../packages/cli/src/cli.ts", import.meta.url),
);
const runCli = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) =>
  command(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), cliPath, ...args],
    {
      cwd,
      env: { ...process.env, AGENT_WORKFLOWS_CONFIG: "", ...env },
      timeoutMs: 20000,
      allowFailure: true,
    },
  );

test("init infers the project, host, agent and validation from the repository", async () => {
  const { root, git } = await repository();
  await git(
    "remote",
    "set-url",
    "origin",
    "git@gitlab.example.com:team/sub/app.git",
  );
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ scripts: { test: "node --test", verify: "pnpm test" } }),
  );
  await writeFile(join(root, "pnpm-lock.yaml"), "");
  const result = await runCli(
    root,
    {},
    "--config",
    join(root, "agent-workflows.json"),
    "init",
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /gitlab team\/sub\/app/);
  assert.match(result.stdout, /Next: agent-workflows doctor/);
  const { readFile } = await import("node:fs/promises");
  const written = JSON.parse(
    await readFile(join(root, "agent-workflows.json"), "utf8"),
  );
  const project = written.projects[0];
  assert.equal(project.id, basename(root).replace(/[^a-zA-Z0-9_-]+/g, "-"));
  assert.equal(project.checkout, ".");
  assert.deepEqual(project.hosting, {
    provider: "gitlab",
    origin: "https://gitlab.example.com",
    repository: "team/sub/app",
    tokenEnv: "GITLAB_TOKEN",
  });
  assert.deepEqual(project.sdlc, {
    enabled: true,
    approvalSource: "local-operator",
  });
  assert.deepEqual(project.validation, [
    { command: "pnpm", args: ["run", "verify"] },
  ]);
});

test("init marks an unknown remote as a placeholder that doctor rejects", async () => {
  const { root, git } = await repository();
  await git("remote", "remove", "origin");
  const config = join(root, "agent-workflows.json");
  const init = await runCli(root, {}, "--config", config, "init");
  assert.equal(init.exitCode, 0, init.stderr);
  assert.match(init.stdout, /Replace placeholder: hosting.repository/);
  const report = JSON.parse(
    (
      await runCli(
        root,
        { AGENT_WORKFLOWS_DATABASE_URL: "" },
        "--config",
        config,
        "doctor",
        "--json",
      )
    ).stdout,
  );
  const repositoryCheck = report.checks.find(
    (item: { name: string }) => item.name === "repository",
  );
  assert.equal(repositoryCheck.status, "fail");
  assert.match(repositoryCheck.detail, /placeholder/);
});

test("a missing hosting token falls back to the gh sign-in only for local approval", async () => {
  const bin = await mkdtemp(join(tmpdir(), "aw-fake-gh-"));
  const calls = join(bin, "calls");
  await writeFile(
    join(bin, "gh"),
    `#!/bin/sh\necho "$@" >> "${calls}"\necho cli-token\n`,
    { mode: 0o755 },
  );
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    AGENT_WORKFLOWS_DATABASE_URL: "",
    FIXTURE_HOST_TOKEN: "",
  };
  const local = await cliFixture({ enabled: true }, "http://127.0.0.1:9");
  const report = JSON.parse(
    (await local.cli(local.root, env, "doctor", "--json")).stdout,
  );
  const credentials = report.checks.find(
    (item: { name: string }) => item.name === "hosting-credentials",
  );
  assert.equal(credentials.status, "pass");
  assert.equal(credentials.detail, "Using the gh sign-in");
  assert.doesNotMatch(JSON.stringify(report), /cli-token/);
  const { readFile } = await import("node:fs/promises");
  assert.match(
    await readFile(calls, "utf8"),
    /^auth token --hostname 127\.0\.0\.1:9$/m,
  );

  const team = await cliFixture(
    { enabled: true, approvalSource: "github", approvers: ["lead"] },
    "http://127.0.0.1:9",
  );
  const refused = JSON.parse(
    (await team.cli(team.root, env, "doctor", "--json")).stdout,
  );
  const missing = refused.checks.find(
    (item: { name: string }) => item.name === "hosting-credentials",
  );
  assert.equal(missing.status, "fail");
  assert.match(missing.detail, /hosting.tokenFromCli/);
});

test("work classify reads the contract from standard input", async () => {
  const { root, cli } = await cliFixture({ enabled: true });
  const { spawnSync } = await import("node:child_process");
  const { configPath } = await cli(root, {}, "doctor", "--json").then(
    (result) => JSON.parse(result.stdout),
  );
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      cliPath,
      "--config-base-directory",
      root,
      "--config",
      configPath,
      "work",
      "classify",
      "--file",
      "-",
    ],
    {
      cwd: root,
      encoding: "utf8",
      input: JSON.stringify({
        title: "Fix sorting",
        intent: "Missing sizes sort last",
        acceptanceCriteria: ["Missing sizes sort last"],
        assessment: { proposedTrack: "A", complexity: "small" },
      }),
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).track, "A");
});
