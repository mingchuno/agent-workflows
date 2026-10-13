import assert from "node:assert/strict";
import { appendFile, unlink, writeFile } from "node:fs/promises";
import { test } from "node:test";
import type { Page } from "@playwright/test";
import { chromium, expect } from "@playwright/test";
import type { MonitorSnapshot } from "../packages/cli/src/web/contracts.js";
import { waitFor } from "./runner-fixtures.js";
import { seedWebEvidence, webRunner } from "./web-fixtures.js";

async function confirmAction(page: Page, label: string) {
  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await page.getByRole("button", { name: label, exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: label, exact: true })
    .click();
}

test("browser distinguishes draft readiness from completed delivery", {
  skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
  const runner = await webRunner();
  t.after(() => runner.stop());
  const browser = await chromium.launch();
  try {
    await runner.store.setProject("fixture", { paused: true });
    const { run } = await seedWebEvidence(runner);
    await runner.store.patchRun(run.id, {
      phase: "push",
      readiness: { draft: true, reasons: ["Blocking findings remain"] },
    });
    const { url } = await runner.access();
    const page = await browser.newPage();
    await page.goto(url);
    await page.getByRole("button", { name: "Checks", exact: true }).click();
    for (const outcome of ["failed", "blocked", "running"] as const) {
      await runner.store.patchRun(run.id, { outcome });
      await expect(
        page.locator("main").getByText(outcome, { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText(
          "Draft required; unresolved checks or findings remain.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(page.getByText(/Draft delivered/)).not.toBeVisible();
    }
    await runner.store.patchRun(run.id, { outcome: "completed" });
    await expect(
      page.getByText("Draft delivered; unresolved checks or findings remain.", {
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    await browser.close();
  }
});

test("browser keeps activity live beyond the first event page", {
  skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
  const runner = await webRunner();
  t.after(() => runner.stop());
  const browser = await chromium.launch();
  try {
    const { run } = await seedWebEvidence(runner);
    for (let index = 0; index < 1000; index++)
      await runner.store.emit(run.id, "step", {
        name: `Recorded step ${index}`,
        status: "completed",
      });
    const { url } = await runner.access();
    const page = await browser.newPage();
    await page.goto(url);
    await page.getByRole("button", { name: "Activity", exact: true }).click();
    await expect(
      page.getByText("Recorded step 999", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Recorded step 0", { exact: true }),
    ).toHaveCount(1);
    await runner.store.emit(run.id, "step", {
      name: "Live step after pagination",
      status: "running",
    });
    await expect(
      page.getByText("Live step after pagination", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Recorded step 999", { exact: true }),
    ).toHaveCount(1);
  } finally {
    await browser.close();
  }
});

test("browser stops active work, retries saved and refreshed issues, and closing it leaves execution running", {
  skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
  const runner = await webRunner({ controlledWorkflow: true });
  t.after(() => runner.stop());
  const browser = await chromium.launch();
  try {
    const { url, origin, cookie } = await runner.access();
    const snapshot = async (): Promise<MonitorSnapshot> =>
      (await fetch(origin + "/api/snapshot", { headers: { cookie } })).json();
    await waitFor(async () =>
      (await snapshot()).runs.some((run) => run.phase === "implementation"),
    );
    const original = (await snapshot()).runs[0]!;
    const page = await browser.newPage();
    await page.goto(url);
    await expect(
      page.getByRole("heading", { name: "Controlled fixture work" }),
    ).toBeVisible();
    await confirmAction(page, "Stop run");
    await waitFor(
      async () =>
        (await snapshot()).runs.find((run) => run.id === original.id)
          ?.outcome === "cancelled",
    );
    await page.getByRole("button", { name: "Pause intake" }).click();
    await expect(
      page.getByRole("button", { name: "Resume intake" }),
    ).toBeVisible();
    await writeFile(runner.issue, "Updated hosted fixture work");
    await confirmAction(page, "Retry run");
    await waitFor(async () =>
      (await snapshot()).runs.some((run) => run.retryOf === original.id),
    );
    const retry = (await snapshot()).runs.find(
      (run) => run.retryOf === original.id,
    )!;
    assert.equal(retry.subject.title, "Controlled fixture work");
    assert.equal(retry.attempt, 2);
    await page
      .getByRole("button", { name: /attempt 2.*Controlled fixture work/ })
      .click();
    await confirmAction(page, "Stop run");
    await waitFor(
      async () =>
        (await snapshot()).runs.find((run) => run.id === retry.id)?.outcome ===
        "cancelled",
    );
    await confirmAction(page, "Retry with refreshed issue");
    await waitFor(async () =>
      (await snapshot()).runs.some((run) => run.retryOf === retry.id),
    );
    const refreshed = (await snapshot()).runs.find(
      (run) => run.retryOf === retry.id,
    )!;
    assert.equal(refreshed.subject.title, "Updated hosted fixture work");
    assert.equal(refreshed.attempt, 3);
    await page.getByRole("button", { name: "Resume intake" }).click();
    await expect(
      page.getByRole("button", { name: "Pause intake" }),
    ).toBeVisible();
    await page.close();
    await writeFile(runner.gate, "continue");
    await waitFor(
      async () =>
        (await snapshot()).runs.find((run) => run.id === refreshed.id)
          ?.outcome === "completed",
    );
  } finally {
    await browser.close();
  }
});

test("browser publication recovery preserves the run and committed evidence while adding an execution", {
  skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
  const runner = await webRunner({
    controlledWorkflow: true,
    publicationFailure: true,
  });
  t.after(() => runner.stop());
  const browser = await chromium.launch();
  try {
    const { url, origin, cookie } = await runner.access();
    const snapshot = async (): Promise<MonitorSnapshot> =>
      (await fetch(origin + "/api/snapshot", { headers: { cookie } })).json();
    await writeFile(runner.gate, "continue");
    await waitFor(async () =>
      (await snapshot()).runs.some(
        (run) => run.outcome === "failed" && run.phase === "change-request",
      ),
    );
    const failed = (await snapshot()).runs[0]!;
    await unlink(runner.publicationFailure);
    const page = await browser.newPage();
    await page.goto(url);
    await expect(
      page.getByRole("heading", { name: "Controlled fixture work" }),
    ).toBeVisible();
    await confirmAction(page, "Recover publication");
    await waitFor(
      async () =>
        (await snapshot()).runs.find((run) => run.id === failed.id)?.outcome ===
        "completed",
    );
    const recovered = (await snapshot()).runs.find(
      (run) => run.id === failed.id,
    )!;
    assert.equal(recovered.head, failed.head);
    assert.equal(recovered.branch, failed.branch);
    assert.equal(recovered.executions?.length, 2);
    assert.equal(
      recovered.executions?.[1]?.recoveryOf,
      failed.executions?.[0]?.id,
    );
    await page.getByRole("button", { name: "Executions", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Prior execution 1" }),
    ).toBeVisible();
    await expect(
      page.getByText("Publication recovery", { exact: true }),
    ).toBeVisible();
  } finally {
    await browser.close();
  }
});

test("operator opens the printed URL, inspects projects and pauses intake in the browser", {
  skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
  const runner = await webRunner();
  t.after(() => runner.stop());
  const browser = await chromium.launch();
  try {
    const { url } = await runner.access();
    const page = await browser.newPage();
    await page.goto(url);
    await expect(
      page.getByRole("heading", { name: "Agent Workflows" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "fixture Intake enabled", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Pause intake" }).click();
    await expect(
      page.getByRole("button", { name: "Resume intake" }),
    ).toBeVisible();
    await expect(page.getByRole("status")).toContainText("pause: success");
    await page.close();
  } finally {
    await browser.close();
  }
});

test("browser preserves selection during live updates and disables commands on stale snapshots", {
  skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
  const runner = await webRunner();
  t.after(() => runner.stop());
  const browser = await chromium.launch();
  try {
    const selected = await seedWebEvidence(runner);
    const { url } = await runner.access();
    const page = await browser.newPage();
    await page.goto(url);
    await expect(
      page.getByRole("heading", { name: "Implement feature" }),
    ).toBeVisible();
    const another = await seedWebEvidence(runner);
    await runner.store.patchRun(another.run.id, {
      subject: { ...another.run.subject, title: "Newly arrived work" },
    });
    await expect(
      page.getByRole("button", { name: /Newly arrived work/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Implement feature" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Logs", exact: true }).click();
    await appendFile(selected.path, "Live appended output\n");
    await expect(
      page.getByText("Live appended output", { exact: true }),
    ).toBeVisible();
    await page.route("**/api/snapshot?*", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Fixture connection unavailable" }),
      }),
    );
    await expect(
      page.getByText("Displayed evidence is stale.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Pause intake" }),
    ).toBeDisabled();
    await page.unroute("**/api/snapshot?*");
    await expect(
      page.getByRole("button", { name: "Pause intake" }),
    ).toBeEnabled();
    await expect(
      page.getByRole("heading", { name: "Implement feature" }),
    ).toBeVisible();
  } finally {
    await browser.close();
  }
});

test("operator inspects run evidence, searches logs and cancels a retry confirmation", {
  skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
  const runner = await webRunner();
  t.after(() => runner.stop());
  const browser = await chromium.launch();
  try {
    await seedWebEvidence(runner);
    const { url } = await runner.access();
    const page = await browser.newPage();
    await page.goto(url);
    await expect(
      page.getByRole("heading", { name: "Implement feature" }),
    ).toBeVisible();
    await expect(
      page.getByText("Recorded validation failure", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Checks", exact: true }).click();
    await expect(page.getByText("exit 1", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Executions", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Current execution" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Sessions", exact: true }).click();
    await expect(page.getByText("session-123", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Logs", exact: true }).click();
    await expect(
      page.getByText("message: Recorded agent output", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("searchbox", { name: "Search log" })
      .fill("validation failed");
    await page.getByRole("button", { name: "Find next" }).click();
    await expect(
      page.getByText("Match at line 2", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Actions", exact: true }).click();
    await page.getByRole("button", { name: "Retry run", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeFocused();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
  } finally {
    await browser.close();
  }
});

test("browser scopes search and filters, switches projects, and inspects prior executions and paged raw logs", {
  skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
  const runner = await webRunner({ additionalProject: true });
  t.after(() => runner.stop());
  const browser = await chromium.launch();
  try {
    const first = await seedWebEvidence(runner);
    const completed = await seedWebEvidence(runner);
    await runner.store.patchRun(completed.run.id, {
      outcome: "completed",
      subject: { ...completed.run.subject, title: "Completed fixture work" },
    });
    const secondary = await seedWebEvidence(runner, "secondary");
    await runner.store.patchRun(secondary.run.id, {
      subject: { ...secondary.run.subject, title: "Secondary fixture work" },
    });
    const prior = {
      ...first.run.executions![0]!,
      id: "prior-fixture-execution",
      startedAt: "2026-10-10T10:00:00Z",
      finishedAt: "2026-10-10T10:00:10Z",
    };
    await runner.store.patchRun(first.run.id, {
      executions: [prior, first.run.executions![0]!],
    });
    await appendFile(
      first.path,
      Array.from(
        { length: 250 },
        (_, index) => `Fixture line ${index + 1}\n`,
      ).join(""),
    );
    const { url } = await runner.access();
    const page = await browser.newPage();
    await page.goto(url);
    await page.getByRole("button", { name: /Implement feature/ }).click();
    await page
      .getByRole("combobox", { name: "Outcome filter" })
      .selectOption("Attention");
    await expect(
      page.getByRole("button", { name: /Completed fixture work/ }),
    ).not.toBeVisible();
    await page
      .getByRole("combobox", { name: "Outcome filter" })
      .selectOption("All");
    await page
      .getByRole("searchbox", { name: "Search runs" })
      .fill("Implement");
    await expect(
      page.getByRole("button", { name: /Completed fixture work/ }),
    ).not.toBeVisible();
    await page
      .getByRole("button", { name: "Diagnostics", exact: true })
      .click();
    await expect(
      page
        .getByRole("region", { name: "Run diagnostic" })
        .getByText("Recorded validation failure", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Executions", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Prior execution 1" }),
    ).toBeVisible();
    await expect(
      page.getByText("failed · validation · 0m 10s", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Logs", exact: true }).click();
    await page.getByRole("button", { name: "Beginning", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Follow log" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Show raw" }).click();
    await expect(
      page.getByText('{"type":"message","text":"Recorded agent output"}', {
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Next lines" }).click();
    await expect(
      page.getByText("Lines 201–252 of 252", { exact: true }),
    ).toBeVisible();
    await page.getByRole("searchbox", { name: "Search runs" }).fill("");
    await page
      .getByRole("button", { name: "secondary Intake enabled", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Secondary fixture work" }),
    ).toBeVisible();
  } finally {
    await browser.close();
  }
});

test("browser inspects collapsible active configuration and retains stale JSON on connection failure", {
  skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
  const runner = await webRunner();
  t.after(() => runner.stop());
  const browser = await chromium.launch();
  try {
    const { run } = await seedWebEvidence(runner);
    const { url } = await runner.access();
    const page = await browser.newPage();
    await page.goto(url);
    await expect(
      page.getByRole("heading", { name: run.subject.title }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Reload configuration", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Configuration", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Active configuration" }),
    ).toBeVisible();
    await expect(
      page.getByRole("complementary", { name: "Runs", exact: true }),
    ).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: "Pause intake", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Reload configuration", exact: true }),
    ).toBeVisible();
    const tree = page.getByRole("tree", { name: "Active configuration JSON" });
    await expect(tree).toBeVisible();
    const projects = tree.getByRole("button", { name: "Expand JSON" }).first();
    await projects.focus();
    await page.keyboard.press("Enter");
    await tree.getByRole("button", { name: "Expand JSON" }).first().focus();
    await page.keyboard.press("Enter");
    await expect(tree.getByText('"checkout":', { exact: true })).toBeVisible();
    await page.route("**/api/configuration", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Runner unavailable" }),
      }),
    );
    await expect(
      page.getByText("Displayed configuration is stale.", { exact: true }),
    ).toBeVisible({ timeout: 10000 });
    await expect(tree.getByText('"checkout":', { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Active configuration" }),
    ).not.toBeVisible();
    await expect(
      page.getByRole("heading", { name: run.subject.title }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Reload configuration", exact: true }),
    ).toHaveCount(0);
  } finally {
    await browser.close();
  }
});
