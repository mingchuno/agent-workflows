import assert from "node:assert/strict";
import { access, mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertStateDirectory } from "../src/runtime/paths.js";
import { repository } from "./fixtures.js";

test("state paths outside checkout resolve without creating source artifacts", async () => {
  const { root } = await repository();
  const directory = await mkdtemp(join(tmpdir(), "state-paths-"));
  assert.equal(
    await assertStateDirectory(root, join(directory, "new", "state")),
    join(await realpath(directory), "new", "state"),
  );
  const nested = join(root, "must-not-create");
  await assert.rejects(assertStateDirectory(root, nested), /outside/);
  await assert.rejects(access(nested));
  const linked = join(directory, "checkout");
  await symlink(root, linked);
  await assert.rejects(
    assertStateDirectory(root, join(linked, "state")),
    /outside/,
  );
});
