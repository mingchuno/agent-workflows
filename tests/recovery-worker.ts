import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configSchema, type Project } from "../src/config.js";
import type {
  ChangeRequest,
  HostingAdapter,
  Publication,
  Snapshot,
} from "../src/domain.js";
import { Runner } from "../src/runner.js";
import { ExistingCheckout } from "../src/workspace.js";
import { agent, FixtureHosting, waitFor } from "./runner-fixtures.js";

const config = configSchema.parse(
  JSON.parse(await readFile(process.argv[2]!, "utf8")),
);
const external = process.argv[3]!;
const fault = process.env.FAULT_PHASE;
function crash(phase: string) {
  if (fault === phase) process.exit(77);
}
class Workspace extends ExistingCheckout {
  override async commit(
    project: Project,
    snapshot: Snapshot,
    text: Publication,
    runId: string,
  ) {
    const head = await super.commit(project, snapshot, text, runId);
    crash("commit");
    return head;
  }
  override async push(project: Project, branch: string, head: string) {
    await super.push(project, branch, head);
    crash("push");
  }
}
class Hosting extends FixtureHosting {
  private async state(): Promise<{
    changes: Array<ChangeRequest & { branch: string }>;
    reviews: string[];
  }> {
    return JSON.parse(await readFile(external, "utf8"));
  }
  override async findChange(branch: string) {
    return (await this.state()).changes.find(
      (change) => change.branch === branch,
    );
  }
  override async createChange(
    input: Parameters<HostingAdapter["createChange"]>[0],
  ) {
    const state = await this.state();
    const change = {
      id: state.changes.length + 1,
      url: "https://fixture.invalid/pr/1",
      head: input.head,
      branch: input.branch,
    };
    state.changes.push(change);
    await writeFile(external, JSON.stringify(state));
    crash("change-request");
    return change;
  }
  override async publishReview(
    input: Parameters<HostingAdapter["publishReview"]>[0],
  ) {
    const state = await this.state();
    if (!state.reviews.includes(input.runId)) {
      state.reviews.push(input.runId);
      await writeFile(external, JSON.stringify(state));
    }
    crash("review");
  }
}
const hosting = new Hosting();
const runner = new Runner({
  config,
  databaseUrl: process.env.TEST_DATABASE_URL!,
  hosting: () => hosting,
  workspace: new Workspace(),
  agents: {
    codex: {
      validate: agent.validate,
      async invoke(input) {
        const output = await agent.invoke(input);
        if (input.step === "implementation") crash("edits");
        return output;
      },
    },
  },
});
try {
  await runner.start();
  await waitFor(async () => {
    const runs = await runner.store.runs();
    return (
      runs.length === 1 && !["queued", "running"].includes(runs[0]!.outcome)
    );
  });
  const runs = await runner.store.runs();
  await writeFile(
    join(config.stateDirectory, "result.json"),
    JSON.stringify({
      runs,
      sessions: await runner.store.invocations(runs[0]!.id),
    }),
  );
} finally {
  await runner.shutdown();
}
