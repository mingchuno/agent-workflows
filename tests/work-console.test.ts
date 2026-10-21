import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { publishRunnerControl } from "../packages/cli/src/cli-runner-control.js";
import { monitorServer } from "../packages/cli/src/web/server.js";
import { configSchema } from "../packages/core/src/config.js";
import { Store } from "../packages/core/src/store.js";
import { sdlcPolicySchema } from "../packages/core/src/work/schema.js";
import { waitFor } from "./runner-fixtures.js";
import { webRunner } from "./web-fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
test("monitor inspects pending Work Items, approves exact revisions and rejects stale or forged approvals", {
  skip: !databaseUrl,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "aw-work-console-"));
  const configPath = join(directory, "config.json");
  const project = {
    id: "visible",
    checkout: directory,
    hosting: {
      provider: "github",
      origin: "https://github.com",
      repository: "a/b",
      tokenEnv: "TOKEN",
    },
    agent: { provider: "codex" },
    sdlc: { enabled: true },
  };
  const config = configSchema.parse({
    id: randomUUID().replaceAll("-", ""),
    stateDirectory: join(directory, "state"),
    projects: [
      project,
      { ...project, id: "hidden" },
      {
        ...project,
        id: "enterprise",
        sdlc: { enabled: true, approvalSource: "github", approvers: ["human"] },
      },
    ],
  });
  const store = new Store(databaseUrl!, config.id);
  let release: (() => Promise<void>) | undefined;
  try {
    await store.initialize();
    for (const item of config.projects) await store.registerProject(item.id);
    release = await publishRunnerControl(configPath, {
      id: config.id,
      databaseUrlEnv: config.databaseUrlEnv,
      databaseUrlHash: "fixture",
      configuration: config,
    });
    const contract = {
      title: "Sort missing sizes",
      intent: "Place missing sizes last",
      acceptanceCriteria: ["Missing sizes follow numbers"],
      scopePaths: ["src/**"],
      assessment: { proposedTrack: "B", complexity: "moderate" },
      verification: { strategy: "Regression test" },
    };
    const visible = await store.workItems.create(
      "visible",
      { kind: "local", key: "sorting" },
      contract,
    );
    const hidden = await store.workItems.create(
      "hidden",
      { kind: "local", key: "private" },
      contract,
    );
    const enterprise = await store.workItems.create(
      "enterprise",
      { kind: "local", key: "enterprise" },
      contract,
    );
    const origin = "http://127.0.0.1:12345";
    const app = monitorServer(store, {
      scope: config.id,
      configPath,
      databaseUrl: databaseUrl!,
      stateDirectory: config.stateDirectory,
      projectIds: ["visible", "enterprise"],
      port: 12345,
      token: "fixture-access",
    });
    const login = await app.request(`${origin}/?token=fixture-access`, {
      headers: { host: "127.0.0.1:12345" },
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const api = (
      path: string,
      body?: unknown,
      extraHeaders: Record<string, string> = {},
    ) =>
      app.request(origin + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          host: "127.0.0.1:12345",
          cookie,
          origin,
          "content-type": "application/json",
          ...extraHeaders,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    assert.equal(
      (
        await app.request(origin + "/api/work-items", {
          headers: { host: "127.0.0.1:12345" },
        })
      ).status,
      401,
    );
    const list = await (await api("/api/work-items")).json();
    assert.deepEqual(
      list.items
        .map((item: { work: { projectId: string } }) => item.work.projectId)
        .sort(),
      ["enterprise", "visible"],
    );
    assert.equal((await api(`/api/work-items/${hidden.id}`)).status, 404);
    assert.equal(
      (
        await api(`/api/work-items/${hidden.id}/approve`, {
          revision: hidden.revision,
          gate: "scope",
        })
      ).status,
      404,
    );
    const inspection = await (
      await api(`/api/work-items/${visible.id}`)
    ).json();
    assert.equal(inspection.decision.state, "awaiting-scope-approval");
    assert.equal(inspection.work.revision, visible.revision);
    assert.equal((await store.runs()).length, 0);
    const endpoint = `/api/work-items/${visible.id}/approve`;
    assert.equal(
      (
        await api(endpoint, {
          revision: visible.revision,
          gate: "scope",
          approvedBy: "pretend-human",
          source: "github",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await api(
          endpoint,
          { revision: visible.revision, gate: "scope" },
          { origin: "https://other.invalid" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await api(`/api/work-items/${enterprise.id}/approve`, {
          revision: enterprise.revision,
          gate: "scope",
        })
      ).status,
      403,
    );
    const edited = await store.workItems.propose(visible.id, visible.revision, {
      ...contract,
      acceptanceCriteria: ["Missing sizes follow numbers in both directions"],
    });
    assert.equal(
      (await api(endpoint, { revision: visible.revision, gate: "scope" }))
        .status,
      409,
    );
    assert.equal((await store.workItems.approvals(visible.id)).length, 0);
    const approved = await api(endpoint, {
      revision: edited.revision,
      gate: "scope",
    });
    assert.equal(approved.status, 200, await approved.clone().text());
    assert.equal((await approved.json()).decision.state, "ready");
    const [record] = await store.workItems.approvals(visible.id);
    assert.equal(record?.approvedBy, userInfo().username);
    assert.equal(record?.source, "local-operator");
    const controlled = await store.workItems.create(
      "visible",
      { kind: "local", key: "controlled" },
      {
        ...contract,
        assessment: { proposedTrack: "C", complexity: "large" },
        design: {
          summary: "Change sorting at its existing boundary",
          stages: ["Comparator and regression coverage"],
          verification: "Exercise missing and numeric sizes",
          rollback: "Revert comparator change",
        },
      },
    );
    const controlledEndpoint = `/api/work-items/${controlled.id}/approve`;
    assert.equal(
      (
        await api(controlledEndpoint, {
          revision: controlled.revision,
          gate: "design",
        })
      ).status,
      409,
    );
    const scoped = await api(controlledEndpoint, {
      revision: controlled.revision,
      gate: "scope",
    });
    assert.equal(scoped.status, 200);
    assert.equal(
      (await scoped.json()).decision.state,
      "awaiting-design-approval",
    );
    const designed = await api(controlledEndpoint, {
      revision: controlled.revision,
      gate: "design",
    });
    assert.equal(designed.status, 200);
    assert.equal((await designed.json()).decision.state, "ready");
    assert.deepEqual(
      (await store.workItems.approvals(controlled.id))
        .map((approval) => approval.gate)
        .sort(),
      ["design", "scope"],
    );
  } finally {
    await release?.();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("browser pins approval confirmation to the inspected Work Item revision", {
  skip: !databaseUrl,
}, async (t) => {
  const runner = await webRunner();
  t.after(() => runner.stop());
  const browser = await chromium.launch();
  try {
    runner.config.projects[0]!.sdlc = sdlcPolicySchema.parse({ enabled: true });
    await writeFile(runner.configPath, JSON.stringify(runner.config));
    const commandId = await runner.store.request("reload", "");
    await waitFor(async () =>
      (await runner.store.commands()).some(
        (command) => command.id === commandId && command.status === "success",
      ),
    );
    const contract = {
      title: "Sort missing sizes",
      intent: "Place missing sizes last",
      acceptanceCriteria: ["Missing sizes follow numbers"],
      scopePaths: ["src/**"],
      assessment: { proposedTrack: "B", complexity: "moderate" },
      verification: { strategy: "Regression test" },
    };
    const work = await runner.store.workItems.create(
      "fixture",
      { kind: "local", key: "browser-sort" },
      contract,
    );
    const { url } = await runner.access();
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    await page.goto(url);
    await page.getByRole("button", { name: "Work Items", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Sort missing sizes", exact: true }),
    ).toBeVisible();
    await expect(page.getByText(work.revision, { exact: true })).toBeVisible();
    await page.screenshot({
      path: "/tmp/aw-work-console-desktop.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "Review scope approval" }).click();
    await expect(
      page.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeFocused();
    const edited = await runner.store.workItems.propose(
      work.id,
      work.revision,
      {
        ...contract,
        acceptanceCriteria: ["Missing sizes follow numbers in both directions"],
      },
    );
    await expect(
      page.getByText(
        "The Work Item changed. Cancel and inspect the current contract.",
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Confirm scope approval" }),
    ).toBeDisabled();
    assert.equal((await runner.store.workItems.approvals(work.id)).length, 0);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Review scope approval" }).click();
    await page.getByRole("button", { name: "Confirm scope approval" }).click();
    await expect(
      page.getByText("Recorded scope approval. Work Item is ready."),
    ).toBeVisible();
    assert.equal((await runner.store.workItems.approvals(work.id)).length, 1);
    await expect(
      page.getByText(edited.revision, { exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole("heading", { name: "Work Items", exact: true }),
    ).toBeVisible();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: "/tmp/aw-work-console-mobile.png",
      fullPage: true,
    });
  } finally {
    await browser.close();
  }
});
