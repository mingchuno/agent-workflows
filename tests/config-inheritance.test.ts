import assert from "node:assert/strict";
import { test } from "node:test";
import { configSchema } from "../packages/core/src/config.js";

const project = {
  id: "app",
  checkout: "../app",
  hosting: { repository: "owner/app" },
  inheritProjectBase: true,
};
const base = {
  hosting: {
    provider: "github",
    origin: "https://github.com",
    tokenEnv: "TOKEN",
  },
  agent: { provider: "codex" },
  workflows: { implementation: { review: { maxFixRounds: 4 } } },
  stages: { review: { promptFile: "prompts/review.md", timeoutMs: 5000 } },
};

test("inheriting projects merge explicit nested values before defaults and validate the result", () => {
  const input = {
    id: "local",
    projectBase: base,
    projects: [
      {
        ...project,
        workflows: { implementation: { enabled: false } },
        stages: { review: { timeoutMs: 9000 } },
      },
    ],
  };
  const before = structuredClone(input);
  const config = configSchema.parse(input);
  assert.equal(
    config.projects[0]!.workflows.implementation.review.maxFixRounds,
    4,
  );
  assert.equal(config.projects[0]!.workflows.implementation.enabled, false);
  assert.equal(
    config.projects[0]!.stages.review.promptFile,
    "prompts/review.md",
  );
  assert.equal(config.projects[0]!.stages.review.timeoutMs, 9000);
  assert.equal(config.projects[0]!.baseBranch, "main");
  assert.deepEqual(config.projects[0]!.hosting, {
    ...base.hosting,
    repository: "owner/app",
  });
  assert.equal("projectBase" in config, false);
  assert.equal("inheritProjectBase" in config.projects[0]!, false);
  assert.deepEqual(input, before);
  assert.deepEqual(configSchema.parse(config), config);
});

test("opt-out projects keep existing defaults and siblings do not share mutable settings", () => {
  const standalone = {
    id: "standalone",
    checkout: ".",
    hosting: { ...base.hosting, repository: "owner/standalone" },
    agent: { provider: "codex" },
  };
  const config = configSchema.parse({
    id: "local",
    projectBase: base,
    projects: [
      project,
      { ...project, id: "second" },
      standalone,
      { ...standalone, id: "explicit", inheritProjectBase: false },
    ],
  });
  assert.equal(
    config.projects[2]!.workflows.implementation.review.maxFixRounds,
    2,
  );
  assert.equal(config.projects[3]!.stages.review.promptFile, undefined);
  config.projects[0]!.workflows.implementation.labels.push("local");
  assert.deepEqual(config.projects[1]!.workflows.implementation.labels, [
    "ready-for-agent",
  ]);
  assert.deepEqual(
    configSchema.parse({
      id: "local",
      projectBase: {},
      projects: [standalone],
    }),
    configSchema.parse({ id: "local", projects: [standalone] }),
  );
});

test("local arrays, maps, false and zero replace explicit inherited values", () => {
  const command = { command: "pnpm", args: ["test"] };
  const config = configSchema.parse({
    id: "local",
    projectBase: {
      ...base,
      validation: [command],
      validationProfiles: { lint: [command], migration: [command] },
      includeAgentCoAuthors: true,
    },
    projects: [
      {
        ...project,
        validation: [],
        validationProfiles: { lint: [{ command: "npm" }] },
        includeAgentCoAuthors: false,
        workflows: {
          implementation: { labels: ["local"], review: { maxFixRounds: 0 } },
        },
      },
    ],
  });
  const resolved = config.projects[0]!;
  assert.deepEqual(resolved.validation, []);
  assert.deepEqual(resolved.validationProfiles.lint, [
    { command: "npm", args: [], timeoutMs: 300000 },
  ]);
  assert.equal(resolved.validationProfiles.migration![0]!.command, "pnpm");
  assert.equal(resolved.includeAgentCoAuthors, false);
  assert.equal(resolved.workflows.implementation.review.maxFixRounds, 0);
  assert.deepEqual(resolved.workflows.implementation.labels, ["local"]);
});

test("prompt source overrides remove the inherited alternative", () => {
  const config = configSchema.parse({
    id: "local",
    projectBase: {
      ...base,
      stages: { ...base.stages, implementation: { prompt: "Inherited text" } },
    },
    projects: [
      {
        ...project,
        stages: {
          review: { prompt: "Local review" },
          implementation: { promptFile: "local.md" },
        },
      },
    ],
  });
  assert.equal(config.projects[0]!.stages.review.promptFile, undefined);
  assert.equal(config.projects[0]!.stages.review.prompt, "Local review");
  assert.equal(config.projects[0]!.stages.implementation.prompt, undefined);
  assert.equal(
    config.projects[0]!.stages.implementation.promptFile,
    "local.md",
  );
});

test("provider switches discard incompatible inherited agent and stage settings", () => {
  const profile = {
    provider: "copilot",
    model: "copilot-model",
    reasoningEffort: "high",
    context: { backgroundCompactionThreshold: 0.7 },
  };
  const config = configSchema.parse({
    id: "local",
    projectBase: { ...base, agent: profile, stages: { review: { profile } } },
    projects: [
      {
        ...project,
        agent: { provider: "codex" },
        stages: {
          review: { profile: { provider: "codex", model: "codex-model" } },
        },
      },
    ],
  });
  assert.deepEqual(config.projects[0]!.agent, { provider: "codex" });
  assert.deepEqual(config.projects[0]!.stages.review.profile, {
    provider: "codex",
    model: "codex-model",
  });
});

test("incomplete fragments are allowed but invalid fragments and merged projects fail with paths", () => {
  for (const fragment of [
    { id: "forbidden" },
    { checkout: "forbidden" },
    { hosting: { repository: "forbidden" } },
    { unknown: true },
    { agent: { provider: "invalid" } },
    { pollIntervalMs: null },
    { workflows: { review: { labels: [] } } },
    { stages: { review: { prompt: "both", promptFile: "both.md" } } },
  ]) {
    assert.equal(
      configSchema.safeParse({
        id: "local",
        projectBase: fragment,
        projects: [],
      }).success,
      false,
    );
    const standalone = {
      ...project,
      inheritProjectBase: false,
      hosting: { ...base.hosting, repository: "owner/app" },
      agent: base.agent,
    };
    assert.equal(
      configSchema.safeParse({
        id: "local",
        projectBase: fragment,
        projects: [standalone],
      }).success,
      false,
    );
  }
  const missing = configSchema.safeParse({ id: "local", projects: [project] });
  assert.equal(missing.success, false);
  if (!missing.success)
    assert.ok(
      missing.error.issues.some(
        (issue) => issue.path.join(".") === "projects.0.inheritProjectBase",
      ),
    );
  assert.equal(
    configSchema.safeParse({
      id: "local",
      projectBase: { agent: base.agent },
      projects: [project],
    }).success,
    false,
  );
  assert.equal(
    configSchema.safeParse({
      id: "local",
      projectBase: {
        ...base,
        stages: { publication: { profile: { provider: "copilot" } } },
      },
      projects: [project],
    }).success,
    false,
  );
});

test("switching a stage's implicitly inherited provider discards base stage model settings", () => {
  const config = configSchema.parse({
    id: "local",
    projectBase: {
      ...base,
      agent: { provider: "copilot" },
      stages: { review: { profile: { model: "copilot-model" } } },
    },
    projects: [
      { ...project, stages: { review: { profile: { provider: "codex" } } } },
    ],
  });
  assert.deepEqual(config.projects[0]!.stages.review.profile, {
    provider: "codex",
  });
});

test("incomplete validation entries in an unused or replaced base do not require command fields before merge", () => {
  const standalone = {
    ...project,
    inheritProjectBase: false,
    hosting: { ...base.hosting, repository: "owner/app" },
    agent: base.agent,
  };
  const projectBase = {
    ...base,
    validation: [{ args: ["test"] }],
    validationProfiles: { lint: [{}] },
  };
  assert.equal(
    configSchema.safeParse({ id: "local", projectBase, projects: [standalone] })
      .success,
    true,
  );
  assert.equal(
    configSchema.safeParse({ id: "local", projectBase, projects: [project] })
      .success,
    false,
  );
  const config = configSchema.parse({
    id: "local",
    projectBase,
    projects: [
      {
        ...project,
        validation: [{ command: "pnpm" }],
        validationProfiles: { lint: [{ command: "npm" }] },
      },
    ],
  });
  assert.equal(config.projects[0]!.validation[0]!.command, "pnpm");
});
