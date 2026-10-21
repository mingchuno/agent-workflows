import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
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
