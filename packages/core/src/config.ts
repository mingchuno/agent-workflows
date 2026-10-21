import { z } from "zod";
import {
  defaultStageTimeoutMs,
  defaultValidationTimeoutMs,
} from "./defaults.js";
import { reviewPrioritySchema } from "./domain.js";
import { sdlcPolicySchema } from "./work/schema.js";

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
    sdlc: sdlcPolicySchema.prefault({}),
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
            review: z
              .strictObject({
                maxFixRounds: z.number().int().nonnegative().default(2),
                blockAtOrAbove: reviewPrioritySchema.default("P2"),
              })
              .prefault({}),
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
const effectiveConfigurationSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  databaseUrlEnv: z.string().default("AGENT_WORKFLOWS_DATABASE_URL"),
  stateDirectory: z.string().default(".agent-workflows"),
  projects: z.array(projectSchema).min(1),
});
// Authoring fragments contain explicit values only: defaults belong to the
// complete project schema after inheritance has been resolved.
const projectFields = projectSchema.shape;
const workflowFields = projectFields.workflows.unwrap().shape;
const implementationFields = workflowFields.implementation.unwrap().shape;
const reviewFields = workflowFields.review.unwrap().shape;
const fragmentStageSchema = z
  .strictObject({
    ...stageSchema.shape,
    timeoutMs: stageSchema.shape.timeoutMs.unwrap().optional(),
  })
  .refine(
    (stage) => stage.prompt === undefined || stage.promptFile === undefined,
    "Specify either prompt or promptFile, never both",
  );
const fragmentPublicationSchema = fragmentStageSchema.safeExtend({
  useNewSession: z.boolean().optional(),
});
const fragmentValidationSchema = validationCommandSchema.extend({
  command: validationCommandSchema.shape.command.optional(),
  args: validationCommandSchema.shape.args.unwrap().optional(),
  timeoutMs: validationCommandSchema.shape.timeoutMs.unwrap().optional(),
});
const fragmentSdlcSchema = z.strictObject({
  enabled: sdlcPolicySchema.shape.enabled.unwrap().optional(),
  defaultTrack: sdlcPolicySchema.shape.defaultTrack.unwrap().optional(),
  allowLocalTasks: sdlcPolicySchema.shape.allowLocalTasks.unwrap().optional(),
  approvalSource: sdlcPolicySchema.shape.approvalSource.unwrap().optional(),
  approvers: sdlcPolicySchema.shape.approvers.unwrap().optional(),
  riskRules: sdlcPolicySchema.shape.riskRules.unwrap().optional(),
});
const fragmentFields = {
  sdlc: fragmentSdlcSchema.optional(),
  hosting: projectFields.hosting.partial().optional(),
  agent: profileSchema.partial().optional(),
  workflows: z
    .strictObject({
      implementation: z
        .strictObject({
          enabled: z.boolean().optional(),
          labels: implementationFields.labels.unwrap().optional(),
          review: z
            .strictObject({
              maxFixRounds: implementationFields.review
                .unwrap()
                .shape.maxFixRounds.unwrap()
                .optional(),
              blockAtOrAbove: reviewPrioritySchema.optional(),
            })
            .optional(),
        })
        .optional(),
      review: z
        .strictObject({
          enabled: z.boolean().optional(),
          labels: reviewFields.labels.unwrap().optional(),
          rereviewOnPush: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
  baseBranch: projectFields.baseBranch.unwrap().optional(),
  remote: projectFields.remote.unwrap().optional(),
  branchTemplate: projectFields.branchTemplate.unwrap().optional(),
  pollIntervalMs: projectFields.pollIntervalMs.unwrap().optional(),
  validation: z.array(fragmentValidationSchema).optional(),
  validationProfiles: z
    .record(
      z.string().regex(/^[a-zA-Z0-9_-]+$/),
      z.array(fragmentValidationSchema).min(1),
    )
    .optional(),
  includeAgentCoAuthors: z.boolean().optional(),
  stages: z
    .strictObject({
      implementation: fragmentStageSchema.optional(),
      publication: fragmentPublicationSchema.optional(),
      review: fragmentStageSchema.optional(),
    })
    .optional(),
};
const projectFragmentSchema = z.strictObject({
  ...fragmentFields,
  id: projectFields.id,
  checkout: projectFields.checkout,
  inheritProjectBase: z.boolean().optional(),
});
const projectBaseSchema = z.strictObject({
  ...fragmentFields,
  hosting: projectFields.hosting
    .omit({ repository: true })
    .partial()
    .optional(),
});
export const configurationInputSchema = z.strictObject({
  ...effectiveConfigurationSchema.shape,
  projectBase: projectBaseSchema.optional(),
  projects: z.array(projectFragmentSchema).min(1),
});

export const configSchema = configurationInputSchema.transform(
  (input, context) => {
    const projects = input.projects.map(
      ({ inheritProjectBase, ...project }, index) => {
        if (!inheritProjectBase) return project;
        if (input.projectBase === undefined) {
          context.addIssue({
            code: "custom",
            message: "inheritProjectBase requires projectBase",
            path: ["projects", index, "inheritProjectBase"],
          });
          return project;
        }
        return mergeProject(input.projectBase, project);
      },
    );
    const { projectBase: _base, ...configuration } = input;
    const result = effectiveConfigurationSchema.safeParse({
      ...configuration,
      projects,
    });
    if (!result.success) {
      for (const issue of result.error.issues) context.addIssue({ ...issue });
      return z.NEVER;
    }
    return result.data;
  },
);
export type ConfigurationInput = z.input<typeof configSchema>;

/** Resolve explicit inheritance, then apply defaults and validate all projects. */
export function resolveConfiguration(input: unknown): Configuration {
  return configSchema.parse(input);
}
export function configurationJson(configuration: Configuration): string {
  return JSON.stringify(configuration, null, 2) + "\n";
}

type ConfigObject = Record<string, unknown>;
function isConfigObject(value: unknown): value is ConfigObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function mergeObjects(
  base: ConfigObject,
  override: ConfigObject,
): ConfigObject {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const inherited = base[key];
    const resolved =
      isConfigObject(inherited) && isConfigObject(value)
        ? mergeObjects(inherited, value)
        : value;
    Object.defineProperty(merged, key, {
      value: resolved,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return merged;
}
function mergeProfile({
  base,
  override,
  inheritedProvider = base?.provider,
  effectiveProvider = override?.provider ?? inheritedProvider,
}: {
  base?: ConfigObject;
  override?: ConfigObject;
  inheritedProvider?: unknown;
  effectiveProvider?: unknown;
}) {
  if (
    inheritedProvider !== undefined &&
    effectiveProvider !== undefined &&
    inheritedProvider !== effectiveProvider
  )
    return override ?? {};
  return mergeObjects(base ?? {}, override ?? {});
}
function mergeProject(
  base: z.infer<typeof projectBaseSchema>,
  project: z.infer<typeof projectFragmentSchema>,
): ConfigObject {
  const merged = mergeObjects(base, project);
  if (base.agent || project.agent)
    merged.agent = mergeProfile({ base: base.agent, override: project.agent });
  if (base.stages || project.stages) {
    const stages: ConfigObject = {};
    for (const name of ["implementation", "publication", "review"] as const) {
      const inherited = base.stages?.[name];
      const override = project.stages?.[name];
      if (!inherited && !override) continue;
      const stage = mergeObjects(inherited ?? {}, override ?? {});
      if (override?.prompt !== undefined) delete stage.promptFile;
      if (override?.promptFile !== undefined) delete stage.prompt;
      if (inherited?.profile || override?.profile)
        stage.profile = mergeProfile({
          base: inherited?.profile,
          override: override?.profile,
          inheritedProvider:
            inherited?.profile?.provider ??
            base.agent?.provider ??
            project.agent?.provider,
          effectiveProvider:
            override?.profile?.provider ??
            inherited?.profile?.provider ??
            (isConfigObject(merged.agent) ? merged.agent.provider : undefined),
        });
      stages[name] = stage;
    }
    merged.stages = stages;
  }
  return merged;
}
export type Project = z.infer<typeof projectSchema>;
export type Configuration = z.infer<typeof effectiveConfigurationSchema>;
export type Stage = z.infer<typeof stageSchema>;
export function resolveProfile(
  defaults: AgentProfile,
  override: Partial<AgentProfile> = {},
): AgentProfile {
  if (override.provider && override.provider !== defaults.provider)
    return profileSchema.parse(override);
  return profileSchema.parse({ ...defaults, ...override });
}
