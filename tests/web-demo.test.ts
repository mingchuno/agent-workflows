import assert from "node:assert/strict";
import { test } from "node:test";
import { createWebDemo } from "./web-demo-fixtures.js";

test("web demo scopes search and exposes evidence without accepting commands", async () => {
  const demo = createWebDemo();
  const snapshot = await demo(
    "/api/snapshot?filter=Attention&query=validated",
    "GET",
  );
  assert.equal(snapshot.status, 200);
  const body = snapshot.body as { visibleRunIds: string[] };
  assert.deepEqual(body.visibleRunIds, ["demo-run-42"]);
  const evidence = await demo("/api/runs/demo-run-42", "GET");
  assert.equal(evidence.status, 200);
  assert.equal((await demo("/api/runs/missing", "GET")).status, 404);
  assert.equal((await demo("/api/commands", "POST")).status, 403);
});
