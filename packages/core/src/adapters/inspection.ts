import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import { command } from "../runtime/process.js";
import { repositoryPathSchema } from "../work/schema.js";

export async function mayReadPath(
  checkout: string,
  path: string,
): Promise<boolean> {
  try {
    const root = await realpath(checkout);
    const target = await realpath(resolve(root, path));
    const within = relative(root, target);
    return (
      !isAbsolute(within) && within !== ".." && !within.startsWith(".." + "/")
    );
  } catch {
    return false;
  }
}
export function inspectionTool(checkout: string, base?: string) {
  const parameters = z.strictObject({
    operation: z.enum(["diff", "show-base", "status"]),
    path: repositoryPathSchema.optional(),
  });
  return defineTool("inspect_git", {
    description:
      "Inspect local changes or the pinned base file without shell access. Use view for current and untracked file contents.",
    parameters,
    handler: async (input) => {
      const { operation, path } = parameters.parse(input);
      const args = ["--no-pager", "-c", "core.fsmonitor=false"];
      if (operation === "status")
        args.push("status", "--short", "--untracked-files=all");
      else {
        if (!base || !/^[a-f0-9]{40,64}$/.test(base))
          throw new Error("Pinned inspection base unavailable");
        if (operation === "show-base") {
          if (!path) throw new Error("A repository-relative path is required");
          args.push("show", `${base}:${path}`);
        } else
          args.push(
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            base,
            "--",
            ...(path ? [path] : []),
          );
      }
      const result = await command("git", args, {
        cwd: checkout,
        timeoutMs: 10000,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      });
      return result.stdout;
    },
  });
}
