import { resolve } from "node:path";
import type { Project } from "../config.js";
import { assertProcessesStopped } from "../runtime/ownership.js";
import { command } from "../runtime/process.js";
import type { Store } from "../store.js";
import { ExistingCheckout } from "../workspace.js";

export function submitWork(input: {
  store: Store;
  project: Project;
  id: string;
  revision: string;
  recoveryStateDirectory?: string;
}) {
  return input.store.workItems.submit(
    input.id,
    input.revision,
    input.project,
    input.recoveryStateDirectory === undefined
      ? undefined
      : {
          checkSafety: async (history) => {
            for (const run of history)
              await assertProcessesStopped(
                resolve(input.recoveryStateDirectory!, run.id),
              );
            const gitDirectory = (
              await command("git", ["rev-parse", "--absolute-git-dir"], {
                cwd: input.project.checkout,
              })
            ).stdout.trim();
            await assertProcessesStopped(
              resolve(gitDirectory, "agent-workflows-processes"),
            );
            await new ExistingCheckout().check(input.project);
          },
        },
  );
}
