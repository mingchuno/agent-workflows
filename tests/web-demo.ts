import { createServer } from "vite";
import { createWebDemo } from "./web-demo-fixtures.js";

const demo = createWebDemo();
const server = await createServer({
  configFile: "web/vite.config.ts",
  define: { "import.meta.env.VITE_MONITOR_FIXTURES": JSON.stringify("true") },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  plugins: [
    {
      name: "read-only-monitor-fixtures",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (!request.url?.startsWith("/api/")) return next();
          void demo(request.url, request.method ?? "GET")
            .then(({ body, status }) => {
              response.writeHead(status, {
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
              });
              response.end(JSON.stringify(body));
            })
            .catch(next);
        });
      },
    },
  ],
});
await server.listen();
console.log(
  "Read-only fixtures: no database, provider calls or workflow commands.",
);
server.printUrls();
server.bindCLIShortcuts({ print: true });
