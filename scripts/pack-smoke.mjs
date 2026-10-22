import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import {
  corePackageName,
  npm,
  packArtifacts,
  packageName,
  recordArtifacts,
} from "./release-package.mjs";

const artifacts = await packArtifacts();
const [coreArtifact, artifact] = artifacts;
assert.equal(coreArtifact.name, corePackageName);
assert.equal(artifact.name, packageName);
assert.equal(coreArtifact.version, artifact.version);
for (const [candidate, directory, required] of [
  [
    coreArtifact,
    "packages/core",
    [
      "dist/src/index.js",
      "dist/src/index.d.ts",
      "dist/src/operator/index.js",
      "dist/src/adapters/agent-worker.js",
      "dist/drizzle/meta/_journal.json",
      "LICENCE",
    ],
  ],
  [
    artifact,
    "packages/cli",
    [
      "dist/src/cli.js",
      "dist/web/index.html",
      "dist/web/fonts/Source-Sans-3-LICENSE.txt",
      "LICENCE",
    ],
  ],
]) {
  const files = candidate.files.map((file) => file.path);
  for (const path of required)
    assert.ok(files.includes(path), `Missing ${candidate.name} file: ${path}`);
  const sources = await readdir(`${directory}/src`, { recursive: true });
  const runtimeFiles = sources
    .filter((file) => /\.tsx?$/.test(file))
    .flatMap((file) => {
      const stem = file.replace(/\.tsx?$/, "");
      return [`dist/src/${stem}.js`, `dist/src/${stem}.d.ts`];
    });
  assert.deepEqual(
    files.filter((file) => file.startsWith("dist/src/")).sort(),
    runtimeFiles.sort(),
    "Packed runtime must match its source modules and declarations",
  );
  assert.ok(
    files.every((file) =>
      /^(dist\/(src|drizzle|web)\/|package\.json$|README\.md$|LICENCE$)/.test(
        file,
      ),
    ),
    "Unexpected development files in published package",
  );
}
assert.ok(
  coreArtifact.files.some((file) => /^dist\/drizzle\/.*\.sql$/.test(file.path)),
);
assert.ok(
  artifact.files.some((file) =>
    /^dist\/web\/assets\/.*\.woff2$/.test(file.path),
  ),
  "Missing self-hosted browser font",
);
assert.ok(
  coreArtifact.files.every(
    (file) => !/^dist\/(web|src\/(tui|web|monitor|cli))/.test(file.path),
  ),
  "Core must not ship application code",
);
assert.ok(
  artifact.files.every(
    (file) =>
      !/^dist\/(drizzle|src\/(db|runner|store|operations|adapters))/.test(
        file.path,
      ),
  ),
  "CLI must consume core rather than duplicate its runtime",
);

const consumer = await mkdtemp(join(tmpdir(), "agent-workflows-package-"));
const manifest = JSON.parse(await readFile("package.json", "utf8"));
const run = (executable, args, options = {}) =>
  execFileSync(executable, args, {
    cwd: consumer,
    encoding: "utf8",
    ...options,
  });

async function checkDatabase() {
  assert.ok(
    process.env.TEST_DATABASE_URL,
    "A disposable test database is required",
  );
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const database = `pack_${randomUUID().replaceAll("-", "")}`;
  const connection = new URL(process.env.TEST_DATABASE_URL);
  connection.pathname = `/${database}`;
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from 'node:assert/strict';
      import { Store } from '@mingchuno/agent-workflows-core';
      const store = new Store(process.env.PACK_DATABASE_URL, 'packed-consumer');
      try {
        await store.initialize();
        await store.initialize();
        await store.registerProject('fixture');
        assert.equal((await store.projects())[0].id, 'fixture');
      } finally { await store.close(); }
    `,
      ],
      { env: { ...process.env, PACK_DATABASE_URL: connection.href } },
    );
  } finally {
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }
}

try {
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  npm(
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      coreArtifact.tarball,
      `typescript@${manifest.devDependencies.typescript.replace(/^\^/, "")}`,
      `@types/node@${manifest.devDependencies["@types/node"].replace(/^\^/, "")}`,
    ],
    { cwd: consumer, stdio: "inherit" },
  );
  const installedCore = join(consumer, "node_modules", corePackageName);
  const coreManifest = JSON.parse(
    await readFile(join(installedCore, "package.json"), "utf8"),
  );
  assert.equal(coreManifest.private, undefined);
  assert.equal(coreManifest.license, "MIT");
  assert.equal(coreManifest.bin, undefined);
  for (const name of [
    "react",
    "ink",
    "hono",
    "@hono/node-server",
    "commander",
  ]) {
    assert.equal(
      coreManifest.dependencies[name],
      undefined,
      `Core must not depend on ${name}`,
    );
    // DBOS has its own Commander dependency; only our direct CLI dependency is excluded.
    if (name === "commander") continue;
    assert.ok(
      !(await readdir(join(consumer, "node_modules"))).includes(name),
      `Core-only install must not install ${name}`,
    );
  }
  assert.equal(
    await readFile(join(installedCore, "LICENCE"), "utf8"),
    await readFile("LICENCE", "utf8"),
  );
  run(process.execPath, [
    "--input-type=module",
    "-e",
    `
    import assert from 'node:assert/strict';
    import { Runner, Store, createAgents, createHosting } from '@mingchuno/agent-workflows-core';
    for (const value of [Runner, Store, createAgents, createHosting]) assert.equal(typeof value, 'function');
  `,
  ]);
  await writeFile(
    join(consumer, "consumer.ts"),
    `
    import { Runner, Store, createAgents, type Configuration, type InvocationTask, type AgentInvocation } from '@mingchuno/agent-workflows-core';
    const agents: ReturnType<typeof createAgents> = createAgents();
    const store: Store = new Store('postgresql://unused', 'consumer');
    const runner: typeof Runner = Runner;
    export type ConsumerConfiguration = Configuration;
    const task: InvocationTask = { defaultPrompt: 'Inspect', preserveCheckout: true, resumeSessionId: 'saved' };
    const session: Pick<AgentInvocation, 'resumeSessionId'> = { resumeSessionId: 'saved' };
    // @ts-expect-error Public PostgreSQL types must not degrade to any.
    store.pool.notAnActualPoolMethod();
    void [agents, store, runner, task, session];
  `,
  );
  run(
    process.execPath,
    [
      join(consumer, "node_modules/typescript/bin/tsc"),
      "consumer.ts",
      "--noEmit",
      "--strict",
      "--module",
      "NodeNext",
      "--target",
      "ES2023",
      "--skipLibCheck",
    ],
    { stdio: "inherit" },
  );
  await checkDatabase();
  npm(
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      artifact.tarball,
    ],
    { cwd: consumer, stdio: "inherit" },
  );
  const installed = join(consumer, "node_modules", packageName);
  const packedManifest = JSON.parse(
    await readFile(join(installed, "package.json"), "utf8"),
  );
  assert.equal(
    packedManifest.dependencies[corePackageName],
    coreArtifact.version,
    "Packed CLI must pin the exact core version",
  );
  assert.equal(packedManifest.version, coreArtifact.version);
  assert.equal(
    packedManifest.exports,
    undefined,
    "SDK consumers use the core package",
  );
  assert.equal(packedManifest.private, undefined);
  assert.equal(packedManifest.license, "MIT");
  assert.equal(
    await readFile(join(installed, "LICENCE"), "utf8"),
    await readFile("LICENCE", "utf8"),
  );
  const cli = join(consumer, "node_modules/.bin/agent-workflows");
  for (const option of ["version", "--version", "-V"])
    assert.equal(run(cli, [option]), `${manifest.version}\n`);
  assert.match(run(cli, ["--help"]), /Durable agent coding workflows/);
  assert.throws(
    () => run(cli, ["--env-file", "missing.env", "init"]),
    (error) =>
      error.status === 1 && /unknown option '--env-file'/.test(error.stderr),
  );
  run(cli, ["init"]);
  const config = JSON.parse(
    await readFile(join(consumer, "agent-workflows.json"), "utf8"),
  );
  // init names the runner and project after the directory it ran in.
  assert.equal(config.id, config.projects[0].id);
  assert.equal(config.projects[0].sdlc.enabled, true);
  assert.equal(config.projects[0].checkout, ".");
  assert.equal(config.envFile, undefined);
  await writeFile(
    join(consumer, "agent-workflows.json"),
    JSON.stringify({ ...config, envFile: "missing.env" }),
  );
  assert.throws(
    () => run(cli, ["status", "--json"]),
    (error) =>
      error.status === 1 &&
      /Cannot read environment file.*ENOENT/.test(error.stderr),
  );
  run(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      "--test",
      resolve("tests/web-package.test.ts"),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PACKED_WEB_CLI: join(installed, "dist/src/cli.js"),
      },
      stdio: "inherit",
    },
  );
  await recordArtifacts(artifacts);
  console.log(
    `Packed core SDK/migrations and CLI/web passed outside the checkout. Tarballs: ${artifacts.map((candidate) => candidate.tarball).join(", ")}`,
  );
} finally {
  await rm(consumer, { recursive: true, force: true });
}
