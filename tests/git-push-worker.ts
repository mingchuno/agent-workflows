import { readFile } from "node:fs/promises";
import type { Project } from "../src/config.js";
import { CheckoutOwnership } from "../src/runtime/ownership.js";
import { ExistingCheckout } from "../src/workspace.js";

const project: Project = JSON.parse(await readFile(process.argv[2]!, "utf8"));
const ownership = new CheckoutOwnership();
await ownership.acquire(project.checkout, process.argv[3]!);
const workspace = new ExistingCheckout();
const snapshot = await workspace.inspect(project);
await workspace.push(project, "agent/interrupted-push", snapshot.head);
await ownership.release();
