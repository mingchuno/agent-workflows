import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  configurationJson,
  resolveConfiguration,
} from "../packages/core/src/config.js";

test("config show prints resolved JSON without requiring runtime services or referenced files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aw-config-show-"));
  const file = join(directory, "config.json");
  const input = {
    id: "local",
    envFile: "missing.env",
    projectBase: {
      hosting: {
        provider: "github",
        origin: "https://github.com",
        tokenEnv: "MISSING_TOKEN",
      },
      agent: { provider: "codex" },
      stages: { review: { promptFile: "missing.md" } },
    },
    projects: [
      {
        id: "app",
        checkout: "missing-checkout",
        inheritProjectBase: true,
        hosting: { repository: "owner/app" },
      },
    ],
  };
  try {
    await writeFile(file, JSON.stringify(input));
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        resolve("packages/cli/src/cli.ts"),
        "--config",
        file,
        "--config-base-directory",
        directory,
        "config",
        "show",
      ],
      { cwd: directory, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const { envFile: _env, ...config } = input;
    assert.equal(
      result.stdout,
      configurationJson(resolveConfiguration(config)),
    );
    assert.equal(result.stderr, "");
    await writeFile(file, JSON.stringify({ ...input, projectBase: {} }));
    const invalid = spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        resolve("packages/cli/src/cli.ts"),
        "--config",
        file,
        "config",
        "show",
      ],
      { cwd: directory, encoding: "utf8" },
    );
    assert.notEqual(invalid.status, 0);
    assert.equal(invalid.stdout, "");
    assert.match(invalid.stderr, /hosting|provider/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
