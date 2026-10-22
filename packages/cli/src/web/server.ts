import { randomBytes, timingSafeEqual } from "node:crypto";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Store } from "@mingchuno/agent-workflows-core";
import {
  ApprovalForbiddenError,
  configurationJson,
  WorkConflictError,
  WorkItemNotFoundError,
  workOperator,
} from "@mingchuno/agent-workflows-core";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import {
  RunnerControlUnavailableError,
  readActiveConfiguration,
} from "../cli-runner-control.js";
import { discoverRuns, runFilters } from "../monitor/discovery.js";
import { webAssetDirectory } from "./assets.js";
import {
  monitorCommandSchema,
  workApprovalSchema,
  workResubmissionSchema,
} from "./contracts.js";
import { MonitorEvidence } from "./evidence.js";
import type { WebStartup } from "./lifecycle.js";

const logQuerySchema = z.object({
  log: z.string().min(1).max(256),
  start: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  raw: z.enum(["true", "false"]).default("false"),
  query: z.string().max(256).optional(),
  direction: z.enum(["next", "previous"]).default("next"),
});
function sameSecret(value: string | undefined, expected: string) {
  if (!value) return false;
  const received = Buffer.from(value);
  const secret = Buffer.from(expected);
  return received.length === secret.length && timingSafeEqual(received, secret);
}

export function monitorServer(store: Store, startup: WebStartup) {
  const app = new Hono();
  const origin = `http://127.0.0.1:${startup.port}`;
  const cookieName = `aw_monitor_${startup.port}`;
  const session = randomBytes(32).toString("hex");
  const evidence = new MonitorEvidence(
    store,
    startup.stateDirectory,
    startup.projectIds,
  );
  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        connectSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
      },
      referrerPolicy: "no-referrer",
    }),
  );
  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    if (context.req.header("host") !== new URL(origin).host)
      return context.json({ error: "Invalid local host" }, 403);
    const requestOrigin = context.req.header("origin");
    if (requestOrigin && requestOrigin !== origin)
      return context.json({ error: "Unrelated browser origin" }, 403);
    if (
      !["GET", "HEAD"].includes(context.req.method) &&
      requestOrigin !== origin
    )
      return context.json({ error: "Monitor origin required" }, 403);
    await next();
  });
  app.get("/", async (context, next) => {
    const token = context.req.query("token");
    if (token !== undefined) {
      if (!sameSecret(token, startup.token))
        return context.text(
          "Access link is invalid. Run agent-workflows monitor --web for the current link.",
          401,
        );
      setCookie(context, cookieName, session, {
        httpOnly: true,
        sameSite: "Strict",
        path: "/",
      });
      return context.redirect("/", 303);
    }
    await next();
  });
  app.use("/api/*", async (context, next) => {
    if (!sameSecret(getCookie(context, cookieName), session))
      return context.json(
        {
          error:
            "Run agent-workflows monitor --web to open the monitor with access.",
        },
        401,
      );
    await next();
  });
  app.get("/api/configuration", async (context) => {
    try {
      return context.text(
        configurationJson(
          await readActiveConfiguration(startup.configPath, startup.scope),
        ),
        200,
        { "Content-Type": "application/json" },
      );
    } catch (error) {
      if (error instanceof RunnerControlUnavailableError)
        return context.json(
          {
            error:
              "Active runner configuration unavailable; start the runner or reconnect.",
          },
          503,
        );
      const detail =
        error instanceof SyntaxError
          ? "Invalid active configuration snapshot JSON"
          : error instanceof z.ZodError
            ? "Invalid active configuration snapshot schema"
            : `Active configuration snapshot read failed (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`;
      console.error(`${detail} for runner ${startup.scope}`);
      return context.json(
        {
          error: `${detail}. Check local control-file permissions and restart the runner.`,
        },
        503,
      );
    }
  });
  app.get("/api/snapshot", async (context) => {
    const filters = z
      .enum(runFilters)
      .safeParse(context.req.query("filter") ?? "All");
    if (!filters.success)
      return context.json({ error: "Invalid outcome filter" }, 400);
    const [projects, runs, commands] = await Promise.all([
      store.projects(),
      store.runs(),
      store.commands(),
    ]);
    const scopedRuns = runs.filter((run) =>
      startup.projectIds.includes(run.projectId),
    );
    return context.json({
      projects: projects.filter((project) =>
        startup.projectIds.includes(project.id),
      ),
      runs: scopedRuns,
      commands,
      visibleRunIds: discoverRuns(
        scopedRuns,
        filters.data,
        (context.req.query("query") ?? "").slice(0, 256),
      ).map((run) => run.id),
    });
  });
  app.get("/api/runs/:id", async (context) =>
    context.json(await evidence.detail(context.req.param("id"))),
  );
  const work = workOperator({
    store,
    stateDirectory: startup.stateDirectory,
    projects: async () =>
      (
        await readActiveConfiguration(startup.configPath, startup.scope)
      ).projects.filter((project) => startup.projectIds.includes(project.id)),
  });
  app.get("/api/work-items", async (context) =>
    context.json({ items: await work.list() }),
  );
  app.get("/api/work-items/:id", async (context) =>
    context.json(await work.inspect(context.req.param("id"))),
  );
  app.use("/api/work-items/:id/approve", bodyLimit({ maxSize: 4096 }));
  app.post("/api/work-items/:id/approve", async (context) => {
    const parsed = workApprovalSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success)
      return context.json(
        { error: "Provide a scope or design gate and the inspected revision" },
        400,
      );
    return context.json(
      await work.approve(context.req.param("id"), parsed.data),
    );
  });
  app.use("/api/work-items/:id/resubmit", bodyLimit({ maxSize: 4096 }));
  app.post("/api/work-items/:id/resubmit", async (context) => {
    const parsed = workResubmissionSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success)
      return context.json({ error: "Provide the inspected revision" }, 400);
    try {
      return context.json(
        await work.resubmit(context.req.param("id"), parsed.data.revision),
      );
    } catch (error) {
      if (error instanceof WorkItemNotFoundError) throw error;
      // Safety and policy refusals tell the operator what to fix first.
      return context.json(
        { error: error instanceof Error ? error.message : String(error) },
        409,
      );
    }
  });
  app.get("/api/runs/:id/log", async (context) => {
    const parsed = logQuerySchema.safeParse(context.req.query());
    if (!parsed.success)
      return context.json({ error: "Invalid log request" }, 400);
    const query = parsed.data;
    return context.json(
      await evidence.log({
        runId: context.req.param("id"),
        logId: query.log,
        start: query.start,
        raw: query.raw === "true",
        query: query.query,
        direction: query.direction === "next" ? 1 : -1,
        signal: context.req.raw.signal,
      }),
    );
  });
  app.use("/api/commands", bodyLimit({ maxSize: 4096 }));
  app.post("/api/commands", async (context) => {
    const parsed = monitorCommandSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success)
      return context.json({ error: "Invalid operator command" }, 400);
    const { kind, target } = parsed.data;
    if (kind === "reload") {
      if (target) return context.json({ error: "Reload has no target" }, 400);
    } else if (kind === "pause" || kind === "resume") {
      if (!startup.projectIds.includes(target))
        return context.json({ error: "Project not found" }, 404);
    } else await evidence.run(target);
    return context.json({ id: await store.request(kind, target) }, 202);
  });
  app.get("*", serveStatic({ root: webAssetDirectory }));
  app.onError((error, context) => {
    if (error instanceof HTTPException)
      return context.json({ error: error.message }, error.status);
    if (error instanceof WorkItemNotFoundError)
      return context.json({ error: "Work item not found" }, 404);
    if (error instanceof ApprovalForbiddenError)
      return context.json({ error: error.message }, 403);
    if (error instanceof WorkConflictError)
      return context.json({ error: error.message }, 409);
    const code = (error as NodeJS.ErrnoException).code;
    return context.json(
      {
        error:
          code === "ENOENT"
            ? "Recorded evidence is unavailable"
            : "Monitor evidence unavailable; check the runner terminal and try again.",
      },
      code === "ENOENT" ? 404 : 503,
    );
  });
  return app;
}
