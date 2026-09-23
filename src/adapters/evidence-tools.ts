import type { Tool, ToolInvocation } from "@github/copilot-sdk";
import type { ChangeEvidence } from "../evidence.js";
import { EvidenceQuery } from "../evidence-query.js";
import type { Emit } from "./sdk-protocol.js";

type ToolOperation = (
  input: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

export function createEvidenceTools(
  evidence: ChangeEvidence,
  emit: Emit,
): Tool[] {
  const query = new EvidenceQuery(evidence);
  const handler =
    (toolName: string, operation: ToolOperation) =>
    async (input: unknown, invocation: ToolInvocation) => {
      emit("event", {
        type: "evidence.tool.started",
        data: { toolName, arguments: input },
      });
      try {
        const result = await operation(
          input as Record<string, unknown>,
          invocation.signal,
        );
        emit("event", {
          type: "evidence.tool.completed",
          data: { toolName },
        });
        return result;
      } catch (error) {
        emit("event", {
          type: "evidence.tool.failed",
          data: { toolName, error: String(error) },
        });
        throw error;
      }
    };

  return [
    {
      name: "evidence_list_changes",
      description:
        "List only this invocation's captured changes in bounded pages. Returns manifest-backed references, change kinds, binary metadata, available chunks, and unread chunks. Start here and paginate until nextPage is null.",
      parameters: {
        type: "object",
        properties: {
          page: { type: "integer", minimum: 1, default: 1 },
          pageSize: { type: "integer", minimum: 1, maximum: 50, default: 25 },
        },
        additionalProperties: false,
      },
      handler: handler("evidence_list_changes", (args, signal) =>
        query.list(args as { page?: number; pageSize?: number }, signal),
      ),
      skipPermission: true,
      defer: "never",
    },
    {
      name: "evidence_read_change",
      description:
        "Read one bounded patch or untracked-content chunk selected by a reference and chunk ordinal returned by evidence_list_changes. Never accepts filesystem paths. Continue until remainingUnreadChunks is zero or report the inspection limit.",
      parameters: {
        type: "object",
        properties: {
          reference: { type: "string", pattern: "^change-[0-9]+$" },
          chunk: { type: "integer", minimum: 0 },
        },
        required: ["reference", "chunk"],
        additionalProperties: false,
      },
      handler: handler("evidence_read_change", (args, signal) =>
        query.read(args as { reference: string; chunk: number }, signal),
      ),
      skipPermission: true,
      defer: "never",
    },
    {
      name: "evidence_search",
      description:
        "Search only this invocation's captured text for a case-sensitive literal term. Returns bounded manifest references, chunk ordinals, line and column locations, previews, and whether more matches exist. Binary changes are counted but not searched.",
      parameters: {
        type: "object",
        properties: {
          term: { type: "string", minLength: 1, maxLength: 256 },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        },
        required: ["term"],
        additionalProperties: false,
      },
      handler: handler("evidence_search", (args, signal) =>
        query.search(args as { term: string; limit?: number }, signal),
      ),
      skipPermission: true,
      defer: "never",
    },
  ];
}
