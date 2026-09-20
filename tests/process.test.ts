import assert from "node:assert/strict";
import { test } from "node:test";
import { command } from "../src/runtime/process.js";

test("command output preserves UTF-8 code points split across stdout chunks", async () => {
  const parts: string[] = [];
  const result = await command(
    process.execPath,
    [
      "-e",
      "process.stdout.write(Buffer.from([0xf0,0x9f])); setTimeout(() => process.stdout.write(Buffer.from([0x98,0x80])), 40);",
    ],
    {
      cwd: process.cwd(),
      strictUtf8: true,
      onOutput: (part) => parts.push(part),
    },
  );
  assert.equal(result.stdout, "😀");
  assert.equal(parts.join(""), "😀");
});
test("command capture limits report overflow explicitly", async () => {
  await assert.rejects(
    command(
      process.execPath,
      ["-e", "process.stdout.write(Buffer.alloc(33 * 1024 * 1024, 120));"],
      { cwd: process.cwd() },
    ),
    /output size .* exceeds capture limit 33554432 bytes/,
  );
});
test("evidence command capture rejects invalid UTF-8 instead of replacing bytes", async () => {
  await assert.rejects(
    command(
      process.execPath,
      ["-e", "process.stdout.write(Buffer.from([0xff]));"],
      { cwd: process.cwd(), strictUtf8: true },
    ),
    /encoded data.*not valid/i,
  );
});
