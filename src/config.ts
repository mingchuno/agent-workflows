import { z } from "zod";

export const profileSchema = z.strictObject({
  provider: z.enum(["codex", "copilot"]),
  model: z.string().min(1).optional(),
  reasoningEffort: z.string().min(1).optional(),
  context: z
    .strictObject({
      backgroundCompactionThreshold: z.number().positive().lt(1).optional(),
      bufferExhaustionThreshold: z.number().positive().lte(1).optional(),
    })
    .optional(),
});
export type AgentProfile = z.infer<typeof profileSchema>;
export const stageSchema = z.strictObject({
  profile: profileSchema.partial().optional(),
  prompt: z.string().default(""),
  skills: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().default(1_800_000),
});
export const projectSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  checkout: z.string().min(1),
  hosting: z.strictObject({
    provider: z.enum(["github", "gitlab"]),
    origin: z.url(),
    repository: z.string().min(1),
    tokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  }),
  labels: z.array(z.string().min(1)).min(1).default(["ready-for-agent"]),
  baseBranch: z.string().min(1).default("main"),
  remote: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .default("origin"),
  branchTemplate: z
    .string()
    .includes("{issue}")
    .default("agent/{issue}-{attempt}"),
  pollIntervalMs: z.number().int().min(100).default(30_000),
  validation: z
    .array(
      z.strictObject({
        command: z.string().min(1),
        args: z.array(z.string()).default([]),
        timeoutMs: z.number().int().positive().default(300_000),
      }),
    )
    .default([]),
  gitIdentity: z.strictObject({ name: z.string().min(1), email: z.email() }),
  agent: profileSchema,
  stages: z
    .strictObject({
      implementation: stageSchema.default(() => ({
        prompt: "",
        skills: [],
        timeoutMs: 1_800_000,
      })),
      writing: stageSchema.default(() => ({
        prompt: "",
        skills: [],
        timeoutMs: 1_800_000,
      })),
      review: stageSchema.default(() => ({
        prompt: "",
        skills: [],
        timeoutMs: 1_800_000,
      })),
    })
    .default(() => ({
      implementation: { prompt: "", skills: [], timeoutMs: 1_800_000 },
      writing: { prompt: "", skills: [], timeoutMs: 1_800_000 },
      review: { prompt: "", skills: [], timeoutMs: 1_800_000 },
    })),
});
export const configSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  databaseUrlEnv: z.string().default("AGENT_WORKFLOWS_DATABASE_URL"),
  stateDirectory: z.string().default(".agent-workflows"),
  projects: z.array(projectSchema).min(1),
});
export type Project = z.infer<typeof projectSchema>;
export type Configuration = z.infer<typeof configSchema>;
export type Stage = z.infer<typeof stageSchema>;
export function resolveProfile(
  defaults: AgentProfile,
  override: Partial<AgentProfile> = {},
): AgentProfile {
  if (override.provider && override.provider !== defaults.provider)
    return profileSchema.parse(override);
  return profileSchema.parse({ ...defaults, ...override });
}
