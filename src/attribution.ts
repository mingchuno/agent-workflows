import type { Project } from "./config.js";
import type { ContributionCandidate, Publication, Snapshot } from "./domain.js";

export const agentCoAuthors = {
  codex: "Codex <noreply@openai.com>",
  copilot: "Copilot <223556219+Copilot@users.noreply.github.com>",
} as const;

export type AttributedProvider = keyof typeof agentCoAuthors;

const trailerLine = /^[A-Za-z0-9][A-Za-z0-9-]*:\s+\S/;

function retained(candidate: ContributionCandidate, final: Snapshot): boolean {
  const paths = new Set([
    ...Object.keys(candidate.beforeFiles),
    ...Object.keys(candidate.afterFiles),
  ]);
  return [...paths].some(
    (path) =>
      candidate.beforeFiles[path] !== candidate.afterFiles[path] &&
      candidate.afterFiles[path] === final.files[path],
  );
}

export function contributingProviders(
  candidates: ContributionCandidate[],
  final: Snapshot,
): AttributedProvider[] {
  const providers = new Set<AttributedProvider>();
  for (const candidate of candidates) {
    if (!(candidate.provider in agentCoAuthors) || !retained(candidate, final))
      continue;
    providers.add(candidate.provider as AttributedProvider);
  }
  return [...providers];
}

export function finalizeCommitMessage(
  publication: Publication,
  project: Project,
  providers: AttributedProvider[],
  runId: string,
): Publication {
  const identities = project.includeAgentCoAuthors
    ? providers.map((provider) => agentCoAuthors[provider])
    : [];
  const matching = new Set(
    identities.map((identity) => `co-authored-by: ${identity}`.toLowerCase()),
  );
  const lines = publication.commitMessage
    .split(/\r?\n/)
    .filter(
      (line) => !line.trim().toLowerCase().startsWith("agent-workflows-run:"),
    );
  while (lines.at(-1)?.trim() === "") lines.pop();
  const separator = lines.findLastIndex((line) => line.trim() === "");
  const possibleTrailers = lines.slice(separator + 1);
  const hasTrailerBlock =
    separator >= 0 &&
    possibleTrailers.length > 0 &&
    possibleTrailers.every(
      (line) => trailerLine.test(line) || /^\s+\S/.test(line),
    );
  const body = hasTrailerBlock ? lines.slice(0, separator) : lines;
  while (body.at(-1)?.trim() === "") body.pop();
  const existingTrailers = hasTrailerBlock
    ? possibleTrailers.filter(
        (line) => !matching.has(line.trim().toLowerCase()),
      )
    : [];
  const finalizedTrailers = [
    ...existingTrailers,
    ...identities.map((identity) => `Co-authored-by: ${identity}`),
    `Agent-Workflows-Run: ${runId}`,
  ];
  return {
    ...publication,
    commitMessage: `${body.join("\n")}\n\n${finalizedTrailers.join("\n")}`,
  };
}
