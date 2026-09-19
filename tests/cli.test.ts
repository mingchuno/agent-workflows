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
