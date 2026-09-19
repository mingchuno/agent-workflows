import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configSchema } from "../src/config.js";
import { Runner } from "../src/runner.js";
import { repository } from "./fixtures.js";
import { agent, FixtureHosting, waitFor } from "./runner-fixtures.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function holdPolling(hosting: FixtureHosting) {
  const entered = deferred();
  const release = deferred();
  hosting.listIssues = async () => {
    entered.resolve();
    await release.promise;
    return hosting.issues;
  };
  return { entered, release };
}
const databaseUrl = process.env.TEST_DATABASE_URL;

test("slow project polling leaves healthy workflows and operator commands responsive", {
  skip: !databaseUrl,
}, async () => {
  const slow = await repository();
  const healthy = await repository();
  slow.project.id = "slow";
  healthy.project.id = "healthy";
  const slowHosting = new FixtureHosting();
  const healthyHosting = new FixtureHosting();
  healthyHosting.identity += "/healthy";
  const polling = holdPolling(slowHosting);
  const runner = new Runner({
    config: configSchema.parse({
      id: "scheduling_" + randomUUID().replaceAll("-", ""),
      stateDirectory: await mkdtemp(join(tmpdir(), "aw-scheduling-")),
      projects: [slow.project, healthy.project],
    }),
    databaseUrl: databaseUrl!,
    hosting: (project) =>
      project.id === "slow" ? slowHosting : healthyHosting,
    agents: { codex: agent },
  });
  const starting = runner.start();
  try {
    await polling.entered.promise;
    const pause = await runner.store.request("pause", "slow");
    await waitFor(async () =>
      (await runner.store.commands()).some(
        (command) => command.id === pause && command.status === "success",
      ),
    );
    await waitFor(async () =>
      (await runner.store.runs()).some(
        (run) => run.projectId === "healthy" && run.outcome === "completed",
      ),
    );
    assert.equal(healthyHosting.changes.length, 1);
  } finally {
    polling.release.resolve();
    await starting;
    await runner.shutdown();
  }
});

test("shutdown during a pending poll never starts the returned issue", {
  skip: !databaseUrl,
}, async () => {
  const { project } = await repository();
  const hosting = new FixtureHosting();
  const polling = holdPolling(hosting);
  let executions = 0;
  const runner = new Runner({
    config: configSchema.parse({
      id: "shutdown_" + randomUUID().replaceAll("-", ""),
      stateDirectory: await mkdtemp(join(tmpdir(), "aw-shutdown-")),
      projects: [project],
    }),
    databaseUrl: databaseUrl!,
    hosting: () => hosting,
    agents: {},
    workflow: async (operations) => {
      await operations.step("observe-start", async () => {
        executions++;
      });
      await operations.complete("no-change");
    },
  });
  const starting = runner.start();
  await polling.entered.promise;
  const stopping = runner.shutdown();
  polling.release.resolve();
  await starting;
  await stopping;
  assert.equal(executions, 0);
});
