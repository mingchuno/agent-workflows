import { configSchema } from "../src/config.js";
import {
  discoverRuns,
  type RunFilter,
  runFilters,
} from "../src/monitor/discovery.js";
import { consoleFixture } from "./tui-demo-fixtures.js";

/** Read-only HTTP fixtures, shared by the development server and its tests. */
export function createWebDemo() {
  const { source, runs } = consoleFixture();
  return async (path: string, method: string) => {
    const url = new URL(path, "http://127.0.0.1");
    const respond = (body: unknown, status = 200) => ({ body, status });
    if (method !== "GET")
      return respond(
        { error: "Read-only fixtures; no workflow commands are sent." },
        403,
      );
    if (url.pathname === "/api/configuration") {
      return respond(
        configSchema.parse({
          id: "fixture-preview",
          projects: ["demo", "web-service"].map((id) => ({
            id,
            checkout: `../${id}`,
            hosting: {
              provider: "github",
              origin: "https://github.com",
              repository: `example/${id}`,
              tokenEnv: "GITHUB_TOKEN",
            },
            agent: { provider: "codex" },
          })),
        }),
      );
    }
    if (url.pathname === "/api/snapshot") {
      const filter = url.searchParams.get("filter") ?? "All";
      if (!runFilters.includes(filter as RunFilter))
        return respond({ error: "Invalid filter" }, 400);
      return respond({
        projects: await source.projects(),
        runs,
        commands: [],
        visibleRunIds: discoverRuns(
          runs,
          filter as RunFilter,
          url.searchParams.get("query") ?? "",
        ).map((run) => run.id),
      });
    }
    const match = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
    const run = runs.find((run) => run.id === match?.[1]);
    if (!run) return respond({ error: "Fixture evidence not found" }, 404);
    return respond({
      run,
      sessions: await source.invocations(run.id),
      events: await source.events(0, run.id),
      logs: [],
      actionReasons: {
        stop: "Read-only fixture preview",
        retry: "Read-only fixture preview",
        recover: "Read-only fixture preview",
      },
    });
  };
}
