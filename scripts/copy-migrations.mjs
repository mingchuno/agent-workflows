import { cp, rm } from "node:fs/promises";

const source = new URL("../drizzle/", import.meta.url);
const target = new URL("../dist/drizzle/", import.meta.url);
await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
