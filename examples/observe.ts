import { Store } from "../src/index.js";

export async function inspectRun(
  databaseUrl: string,
  runnerId: string,
  runId: string,
) {
  const store = new Store(databaseUrl, runnerId);
  try {
    return {
      run: await store.run(runId),
      invocations: await store.invocations(runId),
      events: (await store.events()).filter((event) => event.runId === runId),
    };
  } finally {
    await store.close();
  }
}
