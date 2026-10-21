import assert from "node:assert/strict";
import { test } from "node:test";
import { executionEnvironment } from "../packages/core/src/runtime/environment.js";
import { command } from "../packages/core/src/runtime/process.js";

test("SDLC subprocesses omit runner control credentials and aliases while preserving separate model auth", async () => {
  const input = {
    ...process.env,
    CONTROL_DATABASE: "postgresql://control.invalid/database",
    CONTROL_TOKEN: "hosting-fixture-secret",
    DATABASE_ALIAS: "postgresql://control.invalid/database",
    GITHUB_TOKEN: "hosting-fixture-secret",
    OPENAI_API_KEY: "separate-model-fixture",
    COPILOT_GITHUB_TOKEN: "separate-copilot-fixture",
  };
  const environment = executionEnvironment({
    environment: input,
    controlNames: ["CONTROL_DATABASE", "CONTROL_TOKEN"],
    controlValues: [input.CONTROL_DATABASE, input.CONTROL_TOKEN],
  });
  for (const name of [
    "CONTROL_DATABASE",
    "CONTROL_TOKEN",
    "DATABASE_ALIAS",
    "GITHUB_TOKEN",
  ])
    assert.equal(environment[name], undefined);
  assert.equal(environment.OPENAI_API_KEY, "separate-model-fixture");
  assert.equal(environment.COPILOT_GITHUB_TOKEN, "separate-copilot-fixture");
  assert.equal(input.CONTROL_TOKEN, "hosting-fixture-secret");
  const script = `const assert = require('node:assert/strict'); for (const name of ['CONTROL_DATABASE','CONTROL_TOKEN','DATABASE_ALIAS','GITHUB_TOKEN']) assert.equal(process.env[name], undefined); assert.equal(process.env.OPENAI_API_KEY, 'separate-model-fixture'); console.log('isolated');`;
  const result = await command(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    env: environment,
  });
  assert.equal(result.stdout.trim(), "isolated");
});
