import type { Review, ReviewPositions } from "./domain.js";
import { command } from "./runtime/process.js";

interface PositionInput {
  checkout: string;
  base: string;
  head: string;
  review: Review;
  signal?: AbortSignal;
}

/** Prepare added-line evidence from pinned Git revisions, never the working tree. */
export async function prepareReviewPositions({
  checkout,
  base,
  head,
  review,
  signal,
}: PositionInput): Promise<ReviewPositions> {
  const paths = new Set(
    review.findings
      .filter((finding) => finding.path && finding.line)
      .map((finding) => finding.path!),
  );
  if (!paths.size)
    return {
      inline: [],
      summaryFindings: review.findings.map((finding) => finding.body),
    };
  const git = async (args: string[]) =>
    (await command("git", args, { cwd: checkout, signal })).stdout;
  const status = (
    await git([
      "diff",
      "--name-status",
      "--find-renames",
      "--no-ext-diff",
      "--no-textconv",
      "-z",
      base,
      head,
    ])
  ).split("\0");
  const oldPaths = new Map<string, string>();
  const diffPaths = new Set(paths);
  for (let index = 0; index < status.length - 1; ) {
    const kind = status[index++]!;
    const oldPath = status[index++]!;
    if (kind.startsWith("R") || kind.startsWith("C")) {
      const path = status[index++]!;
      oldPaths.set(path, oldPath);
      if (paths.has(path)) diffPaths.add(oldPath);
    }
  }
  const diff = await git([
    "-c",
    "core.quotePath=false",
    "--literal-pathspecs",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--unified=0",
    "--no-color",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--find-renames",
    base,
    head,
    "--",
    ...diffPaths,
  ]);
  const addedLines = parseAddedLines(diff);
  const positions: ReviewPositions = { inline: [], summaryFindings: [] };
  for (const finding of review.findings) {
    if (
      finding.path &&
      finding.line &&
      addedLines.get(finding.path)?.has(finding.line)
    )
      positions.inline.push({
        body: finding.body,
        path: finding.path,
        oldPath: oldPaths.get(finding.path) ?? finding.path,
        line: finding.line,
      });
    else positions.summaryFindings.push(finding.body);
  }
  return positions;
}

function parseAddedLines(diff: string): Map<string, Set<number>> {
  const paths = new Map<string, Set<number>>();
  let path: string | undefined;
  let line = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  for (const text of diff.split("\n")) {
    if (oldRemaining || newRemaining) {
      if (text.startsWith("+")) {
        if (path) paths.get(path)?.add(line);
        line++;
        newRemaining--;
      } else if (text.startsWith("-")) oldRemaining--;
      else if (text.startsWith(" ")) {
        line++;
        oldRemaining--;
        newRemaining--;
      }
      continue;
    }
    if (text.startsWith("diff --git ")) path = undefined;
    else if (text.startsWith("+++ ")) {
      const filename = decodeGitPath(text.slice(4));
      path = filename.startsWith("b/") ? filename.slice(2) : undefined;
      if (path) paths.set(path, new Set());
    } else {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
      if (!hunk) continue;
      oldRemaining = Number(hunk[2] ?? 1);
      line = Number(hunk[3]);
      newRemaining = Number(hunk[4] ?? 1);
    }
  }
  return paths;
}

/** Git quotes control characters and uses octal byte escapes, not JSON escapes. */
function decodeGitPath(path: string): string {
  // Unquoted names containing spaces have a trailing tab separator.
  if (!path.startsWith('"')) return path.split("\t", 1)[0]!;
  const escapes: Record<string, string> = {
    a: "\x07",
    b: "\b",
    t: "\t",
    n: "\n",
    v: "\v",
    f: "\f",
    r: "\r",
    '"': '"',
    "\\": "\\",
  };
  const bytes: Buffer[] = [];
  for (let index = 1; index < path.length - 1; index++) {
    if (path[index] !== "\\") {
      const start = index;
      while (index + 1 < path.length - 1 && path[index + 1] !== "\\") index++;
      bytes.push(Buffer.from(path.slice(start, index + 1)));
      continue;
    }
    index++;
    const octal = /^[0-7]{3}/.exec(path.slice(index));
    if (octal) {
      bytes.push(Buffer.from([Number.parseInt(octal[0], 8)]));
      index += 2;
    } else bytes.push(Buffer.from(escapes[path[index]!] ?? path[index]!));
  }
  return Buffer.concat(bytes).toString("utf8");
}
