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
let recovering = false;
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
    if (fault?.startsWith("publication-") && !recovering)
      throw new Error("Publication unavailable");
    if (recovering) crash("publication-forked");
    await super.push(project, branch, head);
    if (recovering) crash("publication-effect");
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
if (fault === "publication-admitted") {
  const finishCommand = runner.store.finishCommand.bind(runner.store);
  runner.store.finishCommand = async (id, error) => {
    if (
      !error &&
      (await runner.store.commands()).some(
        (item) => item.id === id && item.kind === "recover",
      )
    )
      crash("publication-admitted");
    await finishCommand(id, error);
  };
}
try {
  await runner.start();
  await waitFor(async () => {
    const runs = await runner.store.runs();
    return (
      runs.length === 1 && !["queued", "running"].includes(runs[0]!.outcome)
    );
  });
  if (fault?.startsWith("publication-")) {
    const run = (await runner.store.runs())[0]!;
    const { DBOS } = await import("@dbos-inc/dbos-sdk");
    await waitFor(
      async () => (await DBOS.getWorkflowStatus(run.id))?.status === "SUCCESS",
    );
    await runner.pause(run.projectId);
    recovering = true;
    const id = await runner.store.request("recover", run.id);
    await waitFor(
      async () =>
        (await runner.store.commands()).find((item) => item.id === id)
          ?.status !== "pending",
    );
    const result = (await runner.store.commands()).find(
      (item) => item.id === id,
    )!;
    if (result.status !== "success") throw new Error(result.error!);
    crash("publication-admitted");
    await runner.resume(run.projectId);
    await waitFor(
      async () => (await runner.store.run(run.id)).outcome === "completed",
    );
  }
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
