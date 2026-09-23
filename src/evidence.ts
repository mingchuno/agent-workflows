import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Project } from "./config.js";
import { BlockedError, type Snapshot } from "./domain.js";
import { sha256 } from "./prompts.js";
import { command, maxCapturedOutputBytes } from "./runtime/process.js";

export const evidenceLimits = {
  chunkBytes: 64 * 1024,
  totalBytes: maxCapturedOutputBytes,
} as const;
export interface EvidenceArtifact {
  path: string;
  sha256: string;
  bytes: number;
}
export interface ChangeEvidence {
  index: string;
  identity: string;
  files: EvidenceArtifact[];
  changedPaths: number;
  base: string;
  head?: string;
  snapshot?: string;
}
/** Split even single long lines, preserving UTF-8 and exact reconstruction. */
export function chunkText(text: string): string[] {
  const buffer = Buffer.from(text);
  const chunks: string[] = [];
  for (let start = 0; start < buffer.length; ) {
    let end = Math.min(start + evidenceLimits.chunkBytes, buffer.length);
    while (end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end--;
    chunks.push(buffer.subarray(start, end).toString("utf8"));
    start = end;
  }
  return chunks;
}
export class EvidenceWriter {
  readonly files: EvidenceArtifact[] = [];
  private bytes = 0;
  constructor(readonly directory: string) {}
  async write(name: string, content: string): Promise<EvidenceArtifact> {
    const bytes = Buffer.byteLength(content);
    const total = this.bytes + bytes;
    if (total > evidenceLimits.totalBytes)
      throw new BlockedError(
        `Change evidence size ${total} bytes exceeds limit ${evidenceLimits.totalBytes} bytes`,
      );
    if (bytes > evidenceLimits.chunkBytes)
      throw new BlockedError(
        `Evidence chunk size ${bytes} exceeds limit ${evidenceLimits.chunkBytes}`,
      );
    const artifact = {
      path: resolve(this.directory, name),
      sha256: sha256(content),
      bytes,
    };
    await writeFile(artifact.path, content, { mode: 0o600, flag: "wx" });
    this.bytes = total;
    this.files.push(artifact);
    return artifact;
  }
  async index(
    contents: string,
    metadata: Record<string, unknown>,
  ): Promise<EvidenceArtifact> {
    let pages = await this.chunks("index", contents);
    let depth = 0;
    const serialize = () =>
      JSON.stringify({
        version: 1,
        ...metadata,
        indexDepth: depth,
        instructions:
          "At depth 0, concatenate pages as JSONL change entries. At greater depth, concatenate pages as a JSON array of page references and descend one level. Read ordered patch chunks; hunk headers carry original line numbers. Untracked content starts at line 1. Report incomplete inspection explicitly.",
        pages,
      });
    while (Buffer.byteLength(serialize()) > evidenceLimits.chunkBytes) {
      depth++;
      pages = await this.chunks(`catalog-${depth}`, JSON.stringify(pages));
    }
    return this.write("index.json", serialize());
  }
  async chunks(prefix: string, content: string) {
    const result = [];
    let byteOffset = 0,
      line = 1;
    for (const [ordinal, part] of chunkText(content).entries()) {
      result.push({
        ...(await this.write(`${prefix}-${ordinal}.txt`, part)),
        ordinal,
        byteOffset,
        startLine: line,
      });
      byteOffset += Buffer.byteLength(part);
      line += part.split("\n").length - 1;
    }
    return result;
  }
}
interface CaptureOptions {
  project: Project;
  directory: string;
  snapshot: Snapshot;
  revisions?: { base: string; head: string };
  signal?: AbortSignal;
}
export async function captureEvidence(
  options: CaptureOptions,
): Promise<ChangeEvidence> {
  const { project, snapshot, revisions, signal } = options;
  const checkout = await realpath(project.checkout);
  const directory = await assertEvidenceDirectory(checkout, options.directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const writer = new EvidenceWriter(directory);
  const git = async (...args: string[]) =>
    (await command("git", args, { cwd: checkout, signal, strictUtf8: true }))
      .stdout;
  const diff = (...args: string[]) =>
    git(
      "--literal-pathspecs",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--full-index",
      ...args,
    );
  const split = (text: string) => text.split("\0").filter(Boolean);
  const untracked = revisions
    ? []
    : split(await git("ls-files", "--others", "--exclude-standard", "-z"));
  const paths = revisions
    ? split(await diff("--name-only", "-z", revisions.base, revisions.head))
    : [
        ...new Set([
          ...snapshot.paths,
          ...split(await diff("--cached", "--name-only", "-z")),
          ...split(await diff("--name-only", "-z")),
          ...untracked,
        ]),
      ].sort();
  const entries: Record<string, unknown>[] = [];
  const addEntry = (entry: Record<string, unknown>) =>
    entries.push({ reference: `change-${entries.length}`, ...entry });
  for (const [number, path] of paths.entries()) {
    signal?.throwIfAborted();
    if (untracked.includes(path)) {
      const content = await readFile(resolve(checkout, path));
      let text: string | undefined;
      try {
        if (!content.includes(0))
          text = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(content);
      } catch {
        /* Binary metadata is intentional. */
      }
      addEntry({
        path,
        kind: "untracked",
        change: "added",
        sha256: sha256(content),
        bytes: content.length,
        binary: text === undefined,
        reason:
          text === undefined
            ? "Binary or non-UTF-8 content; metadata only"
            : undefined,
        chunks:
          text === undefined ? [] : await writer.chunks(`file-${number}`, text),
      });
    }
    const ranges = revisions
      ? [{ kind: "published", args: [revisions.base, revisions.head] }]
      : [
          { kind: "staged", args: ["--cached", snapshot.head] },
          { kind: "unstaged", args: [] as string[] },
        ];
    for (const range of ranges) {
      const patch = await diff(...range.args, "--", path);
      if (!patch) continue;
      const blobs = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/m.exec(patch);
      addEntry({
        path,
        kind: range.kind,
        change: /^new file mode /m.test(patch)
          ? "added"
          : /^deleted file mode /m.test(patch)
            ? "deleted"
            : "modified",
        blobs: blobs ? { before: blobs[1], after: blobs[2] } : undefined,
        sha256: sha256(patch),
        binary: /^Binary files /m.test(patch),
        reason: /^Binary files /m.test(patch)
          ? "Git binary change; metadata only"
          : undefined,
        // Patch headers/hunks preserve original old/new line numbers. Offsets support split long lines.
        chunks: await writer.chunks(`patch-${number}-${range.kind}`, patch),
      });
    }
  }
  const identity = {
    base: revisions?.base ?? snapshot.head,
    ...(revisions
      ? { head: revisions.head }
      : { snapshot: snapshot.fingerprint }),
  };
  const index = await writer.index(
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    { ...identity, changedPaths: paths.length },
  );
  const evidence = {
    ...identity,
    index: index.path,
    identity: index.sha256,
    files: writer.files,
    changedPaths: paths.length,
  };
  await verifyEvidence(evidence);
  return evidence;
}
export async function verifyEvidence(evidence: ChangeEvidence): Promise<void> {
  for (const file of evidence.files) {
    const content = await readFile(file.path).catch((cause) => {
      throw new BlockedError(
        `Required change evidence unavailable: ${file.path}: ${String(cause)}`,
      );
    });
    if (content.length !== file.bytes || sha256(content) !== file.sha256)
      throw new BlockedError(`Change evidence changed: ${file.path}`);
  }
}
export function evidenceContext(evidence: ChangeEvidence): string {
  return `Change evidence index: ${evidence.index}\nIdentity: ${evidence.identity}\nBase: ${evidence.base}\nHead: ${evidence.head ?? "verified dirty snapshot"}\nChanged paths: ${evidence.changedPaths}\nRead the index and its ordered artifacts incrementally. Use read-only tools and do not edit files. Required evidence must be readable; never infer missing content. Binary content is metadata-only.`;
}

/** Resolve through existing ancestors, rejecting source-tree writes before mkdir. */
export async function assertEvidenceDirectory(
  checkout: string,
  requested: string,
): Promise<string> {
  const canonicalCheckout = await realpath(checkout);
  let ancestor = resolve(requested);
  const suffix: string[] = [];
  while (true) {
    try {
      const canonical = await realpath(ancestor);
      const destination = resolve(canonical, ...suffix);
      const location = relative(canonicalCheckout, destination);
      if (
        !location ||
        (!isAbsolute(location) &&
          location !== ".." &&
          !location.startsWith(`..${sep}`))
      )
        throw new BlockedError(
          "State directory for change evidence must be outside the managed checkout",
        );
      return destination;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      suffix.unshift(relative(dirname(ancestor), ancestor));
      ancestor = dirname(ancestor);
    }
  }
}
