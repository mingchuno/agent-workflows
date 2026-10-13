import { rm } from "node:fs/promises";

for (const directory of ["../packages/core/dist/", "../packages/cli/dist/"])
  await rm(new URL(directory, import.meta.url), {
    recursive: true,
    force: true,
  });
