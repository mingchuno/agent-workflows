import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { webRunner } from "./web-fixtures.js";

test("installed package serves the browser and operator controls without source or build tools", {
  skip: !process.env.PACKED_WEB_CLI || !process.env.TEST_DATABASE_URL,
}, async () => {
  const runner = await webRunner({ cli: process.env.PACKED_WEB_CLI });
  const browser = await chromium.launch();
  try {
    const { url, origin } = await runner.access();
    const html = await (await fetch(origin)).text();
    const asset = /src="([^"]+\.js)"/.exec(html)![1]!;
    assert.equal((await fetch(new URL(asset, origin))).status, 200);
    const page = await browser.newPage();
    await page.goto(url);
    await expect(
      page.getByRole("button", { name: "Pause intake" }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Pause intake" }).click();
    await expect(
      page.getByRole("button", { name: "Resume intake" }),
    ).toBeVisible();
  } finally {
    await browser.close();
    await runner.stop();
  }
});
