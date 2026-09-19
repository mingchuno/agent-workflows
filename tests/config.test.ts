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
});
