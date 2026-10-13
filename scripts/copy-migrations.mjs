import { cp, rm } from "node:fs/promises";

const source = new URL("../packages/core/drizzle/", import.meta.url);
const target = new URL("../packages/core/dist/drizzle/", import.meta.url);
await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
