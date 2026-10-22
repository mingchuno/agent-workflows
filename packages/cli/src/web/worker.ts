import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Store } from "@mingchuno/agent-workflows-core";
import { createRedactor } from "@mingchuno/agent-workflows-core/operator";
import { webAssetDirectory } from "./assets.js";
import type { WebStartup } from "./lifecycle.js";
import { monitorServer } from "./server.js";

/** The requested port, or any free one when the default port is taken. */
function choosePort(port: number, fallback: boolean): Promise<number> {
  if (!fallback) return Promise.resolve(port);
  return new Promise((done) => {
    const probe = createServer();
    probe.once("error", () => {
      const free = createServer();
      free.once("error", () => done(port));
      free.listen(0, "127.0.0.1", () => {
        const { port: chosen } = free.address() as { port: number };
        free.close(() => done(chosen));
      });
    });
    probe.listen(port, "127.0.0.1", () => probe.close(() => done(port)));
  });
}

let close: (() => Promise<void>) | undefined;
let stopping = false;
const stop = async () => {
  stopping = true;
  const force = setTimeout(() => process.exit(0), 1500);
  try {
    await close?.();
  } finally {
    clearTimeout(force);
    process.exit(0);
  }
};
process.once("disconnect", () => void stop());
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
process.once("message", (requested: WebStartup) => {
  let startup = requested;
  void (async () => {
    startup = {
      ...requested,
      port: await choosePort(requested.port, requested.fallbackPort ?? false),
    };
    const store = new Store(startup.databaseUrl, startup.scope);
    close = () => store.close();
    await access(join(webAssetDirectory, "index.html"));
    await store.initialize();
    if (stopping || !process.connected) return void stop();
    const app = monitorServer(store, startup);
    const server = serve(
      { fetch: app.fetch, hostname: "127.0.0.1", port: startup.port },
      () => {
        if (process.connected)
          process.send?.({ ready: true, port: startup.port });
      },
    );
    close = async () => {
      if ("closeAllConnections" in server) server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await store.close();
    };
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (process.connected)
        process.send?.({
          error:
            error.code === "EADDRINUSE"
              ? `port ${startup.port} is already in use`
              : `server failed (${error.code ?? "listen error"})`,
        });
      void stop();
    });
  })().catch((error: unknown) => {
    const redact = createRedactor([startup.databaseUrl, startup.token]);
    if (process.connected)
      process.send?.({
        error: `server initialization failed: ${redact(error instanceof Error ? error.message : String(error))}`,
      });
    void stop();
  });
});
