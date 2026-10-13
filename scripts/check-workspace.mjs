import { readFile } from "node:fs/promises";
import { assertWorkspaceVersions } from "./release-package.mjs";

const manifests = await Promise.all(
  [
    "package.json",
    "packages/core/package.json",
    "packages/cli/package.json",
  ].map(async (path) => JSON.parse(await readFile(path, "utf8"))),
);
assertWorkspaceVersions(...manifests);
