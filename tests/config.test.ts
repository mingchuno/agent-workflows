import assert from "node:assert/strict";
import { test } from "node:test";
import { profileSchema, resolveProfile } from "../src/config.js";

test("stage provider overrides do not inherit incompatible provider settings", () => {
  assert.deepEqual(
    resolveProfile(
      {
        provider: "copilot",
        model: "a",
        context: { backgroundCompactionThreshold: 0.7 },
      },
      { provider: "codex", model: "b" },
    ),
    { provider: "codex", model: "b" },
  );
});
test("unknown context controls and credentials are rejected", () => {
  assert.equal(
    profileSchema.safeParse({ provider: "codex", context: { maxTokens: 100 } })
      .success,
    false,
  );
  assert.equal(
    profileSchema.safeParse({ provider: "codex", apiKey: "secret" }).success,
    false,
  );
});

test("project stage defaults are independent between registrations", async () => {
  const { projectSchema } = await import("../src/config.js");
  const input = {
    id: "a",
    checkout: "/tmp",
    hosting: {
      provider: "github",
      origin: "https://github.com",
      repository: "a/b",
      tokenEnv: "TOKEN",
    },
    agent: { provider: "codex" },
    gitIdentity: { name: "Test", email: "test@example.com" },
  };
  const first = projectSchema.parse(input),
    second = projectSchema.parse({ ...input, id: "b" });
  first.stages.review.profile = { provider: "copilot" };
  assert.equal(second.stages.review.profile, undefined);
  assert.throws(
    () => projectSchema.parse({ ...input, stages: { writing: {} } }),
    /renamed to publication/,
  );
  const { projectPrompts, defaultStagePrompts } = await import(
    "../src/prompts.js"
  );
  const prompts = projectPrompts(second);
  for (const [name, text] of Object.entries(defaultStagePrompts))
    assert.equal(prompts[name]!.content, text);
});

test("stage prompts reject ambiguous and blank overrides and removed skills", async () => {
  const { stageSchema } = await import("../src/config.js");
  for (const value of [
    { prompt: " " },
    { promptFile: " " },
    { prompt: "x", promptFile: "x" },
    { skills: [] },
  ]) {
    assert.equal(stageSchema.safeParse(value).success, false);
  }
  assert.equal(stageSchema.parse({}).prompt, undefined);
});

test("prompt files resolve once from an explicit base and preserve literal text", async () => {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { stageSchema } = await import("../src/config.js");
  const { resolveStagePrompt } = await import("../src/prompts.js");
  const directory = await mkdtemp(join(tmpdir(), "stage-prompts-"));
  const file = join(directory, "task.md");
  await writeFile(file, `  literal \${issue} text\n`);
  assert.throws(
    () =>
      resolveStagePrompt(
        stageSchema.parse({ promptFile: "task.md" }),
        "default",
      ),
    /base directory/,
  );
  const stage = stageSchema.parse({ promptFile: "task.md" });
  assert.equal(
    resolveStagePrompt(stage, "default", directory).content,
    `  literal \${issue} text\n`,
  );
  await writeFile(file, "changed");
  assert.equal(
    resolveStagePrompt(stage, "default", directory).content,
    `  literal \${issue} text\n`,
  );
  assert.equal(
    resolveStagePrompt(stageSchema.parse({ promptFile: file }), "default")
      .content,
    "changed",
  );
  assert.throws(
    () =>
      resolveStagePrompt(
        stageSchema.parse({ promptFile: join(directory, "missing.md") }),
        "default",
      ),
    /Cannot read UTF-8 promptFile/,
  );
  assert.throws(
    () =>
      resolveStagePrompt(
        stageSchema.parse({ promptFile: directory }),
        "default",
      ),
    /Cannot read UTF-8 promptFile/,
  );
  await writeFile(file, Buffer.from([0xff]));
  assert.throws(
    () =>
      resolveStagePrompt(stageSchema.parse({ promptFile: file }), "default"),
    /Cannot read UTF-8 promptFile/,
  );
  await writeFile(file, " ");
  assert.throws(
    () =>
      resolveStagePrompt(stageSchema.parse({ promptFile: file }), "default"),
    /nonblank/,
  );
});

test("documented default stage prompts match runtime", async () => {
  const { defaultStagePrompts } = await import("../src/prompts.js");
  const { readFile } = await import("node:fs/promises");
  const documentation = await readFile("docs/configuration.md", "utf8");
  for (const prompt of Object.values(defaultStagePrompts))
    assert.ok(documentation.includes("```text\n" + prompt + "\n```"));
});

test("runner freezes file prompts at initialization and restart fingerprints changed contents", async () => {
  const { writeFile, mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { repository } = await import("./fixtures.js");
  const { Runner } = await import("../src/runner.js");
  const { configSchema } = await import("../src/config.js");
  const { resolveStagePrompt } = await import("../src/prompts.js");
  const { executionFingerprint } = await import("../src/recovery.js");
  const { FixtureHosting } = await import("./runner-fixtures.js");
  const { project } = await repository();
  const directory = await mkdtemp(join(tmpdir(), "runner-prompts-"));
  await writeFile(join(directory, "prompt.md"), "Original instructions");
  project.stages.publication.promptFile = "prompt.md";
  const options = {
    config: configSchema.parse({ id: "prompts", projects: [project] }),
    databaseUrl: "postgresql://localhost/unused",
    agents: {},
    hosting: () => new FixtureHosting(),
  };
  assert.throws(() => new Runner(options), /base directory/);
  const first = new Runner({ ...options, promptBaseDirectory: directory });
  try {
    const before = await executionFingerprint(
      first.config.projects[0]!,
      "version",
    );
    await writeFile(join(directory, "prompt.md"), "New instructions");
    assert.equal(
      resolveStagePrompt(
        first.config.projects[0]!.stages.publication,
        "Default",
      ).content,
      "Original instructions",
    );
    assert.equal(
      await executionFingerprint(first.config.projects[0]!, "version"),
      before,
    );
    const restarted = new Runner({
      ...options,
      promptBaseDirectory: directory,
    });
    try {
      assert.notEqual(
        await executionFingerprint(restarted.config.projects[0]!, "version"),
        before,
      );
    } finally {
      await restarted.store.close();
    }
  } finally {
    await first.store.close();
  }
});
