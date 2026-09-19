import {
  bigserial,
  boolean,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import type { RunRecord } from "../domain.js";
import type { InvocationRecord } from "../store.js";

export const application = pgSchema("agent_workflows");
export const projects = application.table(
  "projects",
  {
    scope: text().notNull(),
    id: text().notNull(),
    paused: boolean().notNull().default(false),
    blocked: text(),
  },
  (table) => [
    primaryKey({ name: "projects_pkey", columns: [table.scope, table.id] }),
  ],
);
export const runs = application.table(
  "runs",
  {
    scope: text().notNull(),
    id: text().primaryKey(),
    taskKey: text("task_key").notNull(),
    attempt: integer().notNull(),
    record: jsonb().$type<RunRecord>().notNull(),
  },
  (table) => [
    unique("runs_scope_task_key_attempt_key").on(
      table.scope,
      table.taskKey,
      table.attempt,
    ),
  ],
);
export const events = application.table("events", {
  sequence: bigserial({ mode: "number" }).primaryKey(),
  scope: text().notNull(),
  runId: text("run_id"),
  kind: text().notNull(),
  payload: jsonb().$type<unknown>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const invocations = application.table("invocations", {
  scope: text().notNull(),
  id: text().primaryKey(),
  runId: text("run_id").notNull(),
  record: jsonb().$type<InvocationRecord>().notNull(),
});
export const commands = application.table("commands", {
  id: text().primaryKey(),
  scope: text().notNull(),
  kind: text().notNull(),
  target: text().notNull(),
  status: text().notNull().default("pending"),
  error: text(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
