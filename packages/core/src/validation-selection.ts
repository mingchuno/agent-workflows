import type { Project } from "./config.js";

const openingFence = /^ {0,3}```agent-workflows-validation[ \t]*$/;
const closingFence = /^ {0,3}```[ \t]*$/;
const profileName = /^[a-zA-Z0-9_-]+$/;

/** Resolve the one ticket-selected set against project-owned commands. */
export function selectValidation(
  body: string,
  project: Project,
): {
  profile?: string;
  commands: Project["validation"];
} {
  const lines = body.split(/\r?\n/);
  let profile: string | undefined;
  for (let index = 0; index < lines.length; index++) {
    if (!openingFence.test(lines[index]!)) continue;
    if (profile !== undefined)
      throw new Error("Duplicate agent-workflows validation block");
    const selected = lines[++index]?.trim();
    if (!selected || !profileName.test(selected))
      throw new Error("Invalid agent-workflows validation profile name");
    if (!closingFence.test(lines[++index] ?? ""))
      throw new Error(
        "Validation block must contain one profile name and a closing fence",
      );
    if (!Object.hasOwn(project.validationProfiles, selected))
      throw new Error(`Unknown validation profile: ${selected}`);
    profile = selected;
  }
  return {
    ...(profile === undefined ? {} : { profile }),
    commands: [
      ...project.validation,
      ...(profile === undefined ? [] : project.validationProfiles[profile]!),
    ],
  };
}
