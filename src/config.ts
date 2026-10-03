import { z } from "zod";
import {
  defaultStageTimeoutMs,
  defaultValidationTimeoutMs,
} from "./defaults.js";

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
export const stageSchema = z
  .strictObject({
    profile: profileSchema.partial().optional(),
    prompt: z
      .string()
      .refine((text) => text.trim().length > 0, "Prompt must be nonblank")
      .optional(),
    promptFile: z
      .string()
      .refine(
        (text) => text.trim().length > 0,
        "Prompt file path must be nonblank",
      )
      .optional(),
    timeoutMs: z.number().int().positive().default(defaultStageTimeoutMs),
  })
  .refine(
    (stage) => stage.prompt === undefined || stage.promptFile === undefined,
    "Specify either prompt or promptFile, never both",
  );
export const publicationStageSchema = stageSchema.safeExtend({
  useNewSession: z.boolean().default(false),
});
const validationCommandSchema = z.strictObject({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().default(defaultValidationTimeoutMs),
});
export const projectSchema = z
  .strictObject({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    checkout: z.string().min(1),
    hosting: z.strictObject({
      provider: z.enum(["github", "gitlab"]),
      origin: z.url(),
      repository: z.string().min(1),
      tokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
    }),
    workflows: z
      .strictObject({
        implementation: z
          .strictObject({
            enabled: z.boolean().default(true),
            labels: z
              .array(z.string().min(1))
              .min(1)
              .default(["ready-for-agent"]),
          })
          .prefault({}),
        review: z
          .strictObject({
            enabled: z.boolean().default(false),
            labels: z
              .array(z.string().min(1))
              .min(1)
              .default(["ready-for-review"]),
            rereviewOnPush: z.boolean().default(false),
          })
          .prefault({}),
      })
      .prefault({}),
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
    validation: z.array(validationCommandSchema).default([]),
    validationProfiles: z
      .record(
        z.string().regex(/^[a-zA-Z0-9_-]+$/),
        z.array(validationCommandSchema).min(1),
      )
      .default({}),
    includeAgentCoAuthors: z.boolean().default(true),
    agent: profileSchema,
    stages: z
      .strictObject({
        implementation: stageSchema.prefault({}),
        publication: publicationStageSchema.prefault({}),
        review: stageSchema.prefault({}),
      })
      .prefault({}),
  })
  .refine(
    (project) =>
      !project.workflows.implementation.enabled ||
      project.stages.publication.useNewSession ||
      resolveProfile(project.agent, project.stages.implementation.profile)
        .provider ===
        resolveProfile(project.agent, project.stages.publication.profile)
          .provider,
    {
      message:
        "Publication must use the implementation provider when useNewSession is false",
      path: ["stages", "publication", "profile", "provider"],
    },
  );
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
