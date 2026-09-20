import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import {
  npm,
  packArtifact,
  packageName,
  recordArtifact,
} from "./release-package.mjs";

const artifact = await packArtifact();
assert.equal(artifact.name, packageName);
const files = artifact.files.map((file) => file.path);
for (const required of [
  "dist/src/index.js",
  "dist/src/index.d.ts",
  "dist/src/cli.js",
  "dist/src/adapters/agent-worker.js",
  "dist/drizzle/meta/_journal.json",
  "LICENCE",
])
  assert.ok(files.includes(required), `Missing package file: ${required}`);
assert.ok(files.some((file) => /^dist\/drizzle\/.*\.sql$/.test(file)));
assert.ok(
  files.every((file) =>
    /^(dist\/(src|drizzle)\/|docs\/|examples\/|package\.json$|README\.md$|LICENCE$)/.test(
      file,
    ),
  ),
  "Unexpected development files in the published package",
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
      import { Store } from '@mingchuno/agent-workflows';
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
      artifact.tarball,
      `typescript@${manifest.devDependencies.typescript.replace(/^\^/, "")}`,
      `@types/node@${manifest.devDependencies["@types/node"].replace(/^\^/, "")}`,
    ],
    { cwd: consumer, stdio: "inherit" },
  );
  const installed = join(consumer, "node_modules", packageName);
  const packedManifest = JSON.parse(
    await readFile(join(installed, "package.json"), "utf8"),
  );
  assert.equal(packedManifest.private, undefined);
  assert.equal(packedManifest.license, "MIT");
  assert.equal(
    await readFile(join(installed, "LICENCE"), "utf8"),
    await readFile("LICENCE", "utf8"),
  );
  run(process.execPath, [
    "--input-type=module",
    "-e",
    `
    import assert from 'node:assert/strict';
    import { Runner, Store, createAgents, createHosting } from '@mingchuno/agent-workflows';
    for (const value of [Runner, Store, createAgents, createHosting]) assert.equal(typeof value, 'function');
  `,
  ]);
  await writeFile(
    join(consumer, "consumer.ts"),
    `
    import { Runner, Store, createAgents, type Configuration } from '@mingchuno/agent-workflows';
    const agents: ReturnType<typeof createAgents> = createAgents();
    const store: Store = new Store('postgresql://unused', 'consumer');
    const runner: typeof Runner = Runner;
    export type ConsumerConfiguration = Configuration;
    // @ts-expect-error Public PostgreSQL types must not degrade to any.
    store.pool.notAnActualPoolMethod();
    void [agents, store, runner];
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
  const cli = join(consumer, "node_modules/.bin/agent-workflows");
  assert.match(run(cli, ["--help"]), /Local durable issue-to-review workflows/);
  assert.throws(
    () => run(cli, ["--env-file", "missing.env", "init"]),
    (error) =>
      error.status === 1 && /Cannot read environment file/.test(error.stderr),
  );
  run(cli, ["init"]);
  const config = JSON.parse(
    await readFile(join(consumer, "agent-workflows.json"), "utf8"),
  );
  assert.equal(config.id, "local");
  assert.equal(config.projects[0].checkout, await realpath(consumer));
  await checkDatabase();
  await recordArtifact(artifact);
  console.log(
    `Packed SDK, CLI and migrations passed outside the checkout. Tarball: ${resolve(artifact.tarball)}`,
  );
} finally {
  await rm(consumer, { recursive: true, force: true });
}
