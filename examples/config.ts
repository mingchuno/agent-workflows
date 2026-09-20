import { configSchema } from "@mingchuno/agent-workflows";

/** Replace paths, repository, identity and model IDs with locally available values. */
export const configuration = configSchema.parse({
  id: "local",
  stateDirectory: "/absolute/path/outside-the-checkout/agent-workflows-state",
  projects: [
    {
      id: "application",
      checkout: "/absolute/path/to/existing-checkout",
      hosting: {
        provider: "gitlab",
        origin: "https://git.example.com/gitlab",
        repository: "group/application",
        tokenEnv: "GITLAB_TOKEN",
      },
      labels: ["ready-for-agent"],
      baseBranch: "main",
      branchTemplate: "agent/{issue}-{attempt}",
      gitIdentity: { name: "Workflow Agent", email: "agent@example.com" },
      agent: { provider: "codex" },
      stages: {
        implementation: {
          prompt: "Implement the issue and follow repository guidance.",
        },
        writing: {
          profile: { provider: "copilot" },
          prompt:
            "Write concise publication text from the diff and validation evidence.",
        },
        review: {
          profile: { provider: "codex" },
          prompt: "Review correctness and requirements independently.",
        },
      },
      validation: [{ command: "pnpm", args: ["test"], timeoutMs: 300_000 }],
    },
  ],
});

// Explicit model selection is checked against provider capabilities before invocation.
export const modelOverrides = {
  implementation: {
    provider: "codex" as const,
    model: "YOUR_CODEX_MODEL",
    reasoningEffort: "high",
  },
  writing: {
    provider: "copilot" as const,
    model: "YOUR_COPILOT_MODEL",
    reasoningEffort: "low",
    context: {
      backgroundCompactionThreshold: 0.8,
      bufferExhaustionThreshold: 0.95,
    },
  },
};
