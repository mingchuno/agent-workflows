import { randomBytes, timingSafeEqual } from "node:crypto";
import { userInfo } from "node:os";
import { serveStatic } from "@hono/node-server/serve-static";
import type {
  Project,
  RunRecord,
  Store,
} from "@mingchuno/agent-workflows-core";
import { configurationJson } from "@mingchuno/agent-workflows-core";
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
import { monitorCommandSchema, workApprovalSchema } from "./contracts.js";
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
          "Access link is invalid. Open the URL printed by run.",
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
        { error: "Open the access URL printed by run to connect." },
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
  const workProject = async (id: string) => {
    const work = await store.workItems.get(id).catch((error) => {
      if (
        error instanceof Error &&
        error.message.startsWith("Unknown work item:")
      )
        throw new HTTPException(404, { message: "Work item not found" });
      throw error;
    });
    if (!startup.projectIds.includes(work.projectId))
      throw new HTTPException(404, { message: "Work item not found" });
    const configuration = await readActiveConfiguration(
      startup.configPath,
      startup.scope,
    );
    const project = configuration.projects.find(
      (item) => item.id === work.projectId && item.sdlc.enabled,
    );
    if (!project)
      throw new HTTPException(404, { message: "SDLC project not found" });
    return project;
  };
  const inspectWork = async (
    id: string,
    project?: Project,
    runs?: RunRecord[],
  ) => {
    project ??= await workProject(id);
    const inspection = await store.workItems.inspect(id, project);
    const runIds = (runs ?? (await store.runs()))
      .filter(
        (run) => run.projectId === project.id && run.work?.workItemId === id,
      )
      .map((run) => run.id);
    return {
      ...inspection,
      approvalSource: project.sdlc.approvalSource,
      runIds,
    };
  };
  app.get("/api/work-items", async (context) => {
    const configuration = await readActiveConfiguration(
      startup.configPath,
      startup.scope,
    );
    const projects = configuration.projects.filter(
      (project) =>
        startup.projectIds.includes(project.id) && project.sdlc.enabled,
    );
    const items = [];
    const runs = await store.runs();
    for (const project of projects) {
      for (const work of await store.workItems.list(project.id))
        items.push(await inspectWork(work.id, project, runs));
    }
    return context.json({ items });
  });
  app.get("/api/work-items/:id", async (context) =>
    context.json(await inspectWork(context.req.param("id"))),
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
    const id = context.req.param("id");
    const project = await workProject(id);
    if (project.sdlc.approvalSource !== "local-operator")
      return context.json(
        {
          error:
            "This project requires authenticated allowed-human approval from its configured host",
        },
        403,
      );
    const operator = userInfo().username;
    if (
      project.sdlc.approvers.length &&
      !project.sdlc.approvers.includes(operator)
    )
      return context.json(
        {
          error:
            "This local operator is not an allowed approver for the project",
        },
        403,
      );
    const { work, decision } = await store.workItems.inspect(id, project);
    if (work.revision !== parsed.data.revision)
      return context.json(
        {
          error:
            "Work revision changed. Inspect the current contract before approving.",
        },
        409,
      );
    const requiredState =
      parsed.data.gate === "scope"
        ? "awaiting-scope-approval"
        : "awaiting-design-approval";
    if (decision.state !== requiredState)
      return context.json(
        {
          error:
            "This gate is no longer awaiting approval. Refresh the Work Item.",
        },
        409,
      );
    try {
      await store.workItems.approve(
        id,
        parsed.data.revision,
        parsed.data.gate,
        { approvedBy: operator, source: "local-operator" },
        project,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        /revision changed|Source changed/.test(error.message)
      )
        return context.json({ error: error.message }, 409);
      throw error;
    }
    return context.json(await inspectWork(id));
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
