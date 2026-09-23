import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  type ChangeEvidence,
  type EvidenceArtifact,
  verifyEvidence,
} from "./evidence.js";
import { sha256 } from "./prompts.js";

export const evidenceQueryLimits = {
  defaultPageSize: 25,
  maxPageSize: 50,
  defaultSearchResults: 20,
  maxSearchResults: 50,
  maxSearchTermBytes: 256,
  previewCharacters: 512,
  maxResponseBytes: 512 * 1024,
} as const;

const artifactSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().min(1),
  bytes: z.number().int().nonnegative(),
});
const chunkSchema = artifactSchema.extend({
  ordinal: z.number().int().nonnegative(),
  byteOffset: z.number().int().nonnegative(),
  startLine: z.number().int().positive(),
});
const changeSchema = z.object({
  reference: z.string().regex(/^change-[0-9]+$/),
  path: z.string().min(1),
  kind: z.string().min(1),
  change: z.enum(["added", "modified", "deleted"]),
  sha256: z.string().min(1),
  binary: z.boolean(),
  reason: z.string().optional(),
  chunks: z.array(chunkSchema),
});
type EvidenceChange = z.infer<typeof changeSchema>;

const listArguments = z.strictObject({
  page: z.number().int().positive().default(1),
  pageSize: z
    .number()
    .int()
    .positive()
    .max(evidenceQueryLimits.maxPageSize)
    .default(evidenceQueryLimits.defaultPageSize),
});
const readArguments = z.strictObject({
  reference: z.string().min(1),
  chunk: z.number().int().nonnegative(),
});
const searchArguments = z.strictObject({
  term: z
    .string()
    .min(1)
    .refine(
      (term) =>
        Buffer.byteLength(term) <= evidenceQueryLimits.maxSearchTermBytes,
      `Search term exceeds ${evidenceQueryLimits.maxSearchTermBytes} bytes`,
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(evidenceQueryLimits.maxSearchResults)
    .default(evidenceQueryLimits.defaultSearchResults),
});

export type ListEvidenceArguments = z.input<typeof listArguments>;
export type ReadEvidenceArguments = z.input<typeof readArguments>;
export type SearchEvidenceArguments = z.input<typeof searchArguments>;

/** A stateful, read-only view of one invocation's verified evidence manifest. */
export class EvidenceQuery {
  private changes?: EvidenceChange[];
  private readonly readChunks = new Set<string>();

  constructor(private readonly evidence: ChangeEvidence) {}

  async list(input: ListEvidenceArguments, signal?: AbortSignal) {
    const { page, pageSize } = listArguments.parse(input);
    const changes = await this.load(signal);
    const totalPages = Math.max(1, Math.ceil(changes.length / pageSize));
    if (page > totalPages)
      throw new Error(
        `Evidence page ${page} is absent; available pages are 1-${totalPages}`,
      );
    const pageChanges = changes.slice((page - 1) * pageSize, page * pageSize);
    return this.bounded({
      page,
      pageSize,
      totalPages,
      totalChanges: changes.length,
      changedPaths: this.evidence.changedPaths,
      nextPage: page < totalPages ? page + 1 : null,
      unreadChunks: this.countUnread(changes),
      changes: pageChanges.map((change) => ({
        reference: change.reference,
        path: change.path,
        kind: change.kind,
        change: change.change,
        binary: change.binary,
        reason: change.reason,
        chunks: change.chunks.map(({ ordinal, bytes, startLine }) => ({
          ordinal,
          bytes,
          startLine,
        })),
        unreadChunks: change.chunks
          .filter((chunk) => !this.readChunks.has(this.chunkKey(change, chunk)))
          .map((chunk) => chunk.ordinal),
      })),
    });
  }

  async read(input: ReadEvidenceArguments, signal?: AbortSignal) {
    const { reference, chunk: ordinal } = readArguments.parse(input);
    const changes = await this.load(signal);
    const change = changes.find(
      (candidate) => candidate.reference === reference,
    );
    if (!change) throw new Error(`Evidence reference ${reference} is absent`);
    const chunk = change.chunks.find(
      (candidate) => candidate.ordinal === ordinal,
    );
    if (!chunk)
      throw new Error(
        `Evidence chunk ${ordinal} is absent from reference ${reference}`,
      );
    const text = await this.readManifestArtifact(chunk, signal);
    this.readChunks.add(this.chunkKey(change, chunk));
    return this.bounded({
      reference,
      path: change.path,
      kind: change.kind,
      change: change.change,
      binary: change.binary,
      chunk: ordinal,
      startLine: chunk.startLine,
      byteOffset: chunk.byteOffset,
      bytes: chunk.bytes,
      text,
      remainingUnreadChunks: change.chunks.filter(
        (candidate) => !this.readChunks.has(this.chunkKey(change, candidate)),
      ).length,
    });
  }

  async search(input: SearchEvidenceArguments, signal?: AbortSignal) {
    const { term, limit } = searchArguments.parse(input);
    const changes = await this.load(signal);
    const matches: Array<{
      reference: string;
      path: string;
      kind: string;
      chunk: number;
      line: number;
      column: number;
      previewStartColumn: number;
      preview: string;
    }> = [];
    let hasMore = false;
    for (const change of changes) {
      signal?.throwIfAborted();
      if (change.binary || change.chunks.length === 0) continue;
      const parts = await Promise.all(
        change.chunks.map((chunk) => this.readManifestArtifact(chunk, signal)),
      );
      const content = parts.join("");
      const characterOffsets: number[] = [];
      let characterOffset = 0;
      for (const part of parts) {
        characterOffsets.push(characterOffset);
        characterOffset += part.length;
      }
      for (let offset = content.indexOf(term); offset >= 0; ) {
        if (matches.length === limit) {
          hasMore = true;
          break;
        }
        const before = content.slice(0, offset);
        const lineStart = before.lastIndexOf("\n") + 1;
        const lineEnd = content.indexOf("\n", offset);
        const previewStart = Math.max(lineStart, offset - 80);
        const previewEnd = Math.min(
          lineEnd < 0 ? content.length : lineEnd,
          previewStart + evidenceQueryLimits.previewCharacters,
        );
        const chunkIndex = Math.max(
          0,
          characterOffsets.findLastIndex((start) => start <= offset),
        );
        matches.push({
          reference: change.reference,
          path: change.path,
          kind: change.kind,
          chunk: change.chunks[chunkIndex]!.ordinal,
          line: before.split("\n").length,
          column: offset - lineStart + 1,
          previewStartColumn: previewStart - lineStart + 1,
          preview: content.slice(previewStart, previewEnd),
        });
        offset = content.indexOf(term, offset + Math.max(1, term.length));
      }
      if (hasMore) break;
    }
    return this.bounded({
      term,
      limit,
      searchedChanges: changes.filter((change) => !change.binary).length,
      binaryChanges: changes.filter((change) => change.binary).length,
      matches,
      truncated: hasMore,
      unreadChunks: this.countUnread(changes),
    });
  }

  private async load(signal?: AbortSignal): Promise<EvidenceChange[]> {
    signal?.throwIfAborted();
    await verifyEvidence(this.evidence);
    if (this.changes) return this.changes;
    const indexArtifact = this.manifestArtifact({
      path: this.evidence.index,
      sha256: this.evidence.identity,
    });
    const root = z
      .object({
        version: z.literal(1),
        indexDepth: z.number().int().nonnegative(),
        pages: z.array(artifactSchema),
      })
      .parse(
        JSON.parse(await this.readManifestArtifact(indexArtifact, signal)),
      );
    let pages = root.pages;
    for (let depth = root.indexDepth; depth > 0; depth--) {
      const catalog = await this.readPages(pages, signal);
      pages = z.array(artifactSchema).parse(JSON.parse(catalog));
    }
    const jsonl = await this.readPages(pages, signal);
    this.changes = jsonl
      .split("\n")
      .filter(Boolean)
      .map((line) => changeSchema.parse(JSON.parse(line)));
    if (
      new Set(this.changes.map((change) => change.reference)).size !==
      this.changes.length
    )
      throw new Error("Evidence manifest contains duplicate change references");
    return this.changes;
  }

  private async readPages(
    pages: EvidenceArtifact[],
    signal?: AbortSignal,
  ): Promise<string> {
    const parts = [];
    for (const page of pages) {
      signal?.throwIfAborted();
      parts.push(await this.readManifestArtifact(page, signal));
    }
    return parts.join("");
  }

  private manifestArtifact(
    reference: Pick<EvidenceArtifact, "path" | "sha256"> &
      Partial<Pick<EvidenceArtifact, "bytes">>,
  ): EvidenceArtifact {
    const artifact = this.evidence.files.find(
      (candidate) => candidate.path === reference.path,
    );
    if (
      !artifact ||
      artifact.sha256 !== reference.sha256 ||
      (reference.bytes !== undefined && artifact.bytes !== reference.bytes)
    )
      throw new Error(
        `Evidence artifact is absent from manifest: ${reference.path}`,
      );
    return artifact;
  }

  private async readManifestArtifact(
    reference: EvidenceArtifact,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    const artifact = this.manifestArtifact(reference);
    const content = await readFile(artifact.path);
    if (
      content.length !== artifact.bytes ||
      sha256(content) !== artifact.sha256
    )
      throw new Error(`Change evidence changed: ${artifact.path}`);
    return content.toString("utf8");
  }

  private chunkKey(
    change: EvidenceChange,
    chunk: EvidenceArtifact & { ordinal: number },
  ) {
    return `${change.reference}:${chunk.ordinal}`;
  }

  private countUnread(changes: EvidenceChange[]): number {
    return changes.reduce(
      (total, change) =>
        total +
        change.chunks.filter(
          (chunk) => !this.readChunks.has(this.chunkKey(change, chunk)),
        ).length,
      0,
    );
  }

  private bounded<T>(response: T): T {
    const bytes = Buffer.byteLength(JSON.stringify(response));
    if (bytes > evidenceQueryLimits.maxResponseBytes)
      throw new Error(
        `Evidence tool response ${bytes} bytes exceeds limit ${evidenceQueryLimits.maxResponseBytes} bytes; request a smaller page or search limit`,
      );
    return response;
  }
}
