import { randomUUID } from "node:crypto";
import { and, eq, gt, Param, SQL } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { tryLock, unlockAll } from "./db/locks.js";
import { migrateDatabase } from "./db/migrations.js";
import * as tables from "./db/schema.js";
import type { RunRecord } from "./domain.js";
import { createQueuedRun } from "./run-record.js";
import { redactValue } from "./runtime/redaction.js";

export interface EventRecord {
  sequence: number;
  runId: string | null;
  kind: string;
  payload: unknown;
  createdAt: string;
}
export interface ProjectState {
  id: string;
  paused: boolean;
  blocked: string | null;
}
export interface InvocationRecord {
  id: string;
  runId: string;
  projectId: string;
  step: string;
  stepId: number;
  attempt: number;
  provider: string;
  sessionId: string | null;
  sessionState: "pending" | "available" | "unavailable";
  requested: unknown;
  effective: unknown;
  prompt: string;
  skills: unknown;
  outcome: string;
  startedAt: string;
  finishedAt?: string;
  log: string;
}
interface RetryAdmission {
  commandId?: string;
  checkSafety: (
    previous: RunRecord,
  ) => Promise<{ checkout: string; branchTemplate: string }>;
}
/** Public persisted query surface. All queries work without a running executor. */
export class Store {
  readonly pool: Pool;
  private readonly db: NodePgDatabase;
  private ownership?: PoolClient;
  constructor(
    databaseUrl: string,
    readonly scope: string,
    private readonly redact: (text: string) => string = (text) => text,
  ) {
    this.pool = new Pool({ connectionString: databaseUrl });
    this.db = drizzle(this.pool);
  }
  async initialize(): Promise<void> {
    await migrateDatabase(this.pool);
  }
  async acquire(keys: string[], onLost: () => void): Promise<void> {
    this.ownership = await this.pool.connect();
    this.ownership.on("error", onLost);
    try {
      for (const key of [
        `runner:${this.scope}`,
        ...keys.map((key) => `checkout:${key}`),
      ]) {
        if (!(await tryLock(this.ownership, key))) {
          throw new Error(`Already owned by another runner: ${key}`);
        }
      }
    } catch (error) {
      await this.release();
      throw error;
    }
  }
  async release(): Promise<void> {
    const client = this.ownership;
    if (!client) return;
    this.ownership = undefined;
    try {
      await unlockAll(client);
    } finally {
      client.removeAllListeners("error");
      client.release(true);
    }
  }
  async close(): Promise<void> {
    try {
      await this.release();
    } finally {
      await this.pool.end();
    }
  }
  async registerProject(id: string): Promise<void> {
    await this.db
      .insert(tables.projects)
      .values({ scope: this.scope, id })
      .onConflictDoNothing();
  }
  async projects(): Promise<ProjectState[]> {
    const { projects } = tables;
    return this.db
      .select({
        id: projects.id,
        paused: projects.paused,
        blocked: projects.blocked,
      })
      .from(projects)
      .where(eq(projects.scope, this.scope))
      .orderBy(projects.id);
  }
  async project(id: string): Promise<ProjectState> {
    const state = (await this.projects()).find((project) => project.id === id);
    if (!state) throw new Error(`Unknown project: ${id}`);
    return state;
  }
  async setProject(
    id: string,
    change: { paused?: boolean; blocked?: string | null },
  ): Promise<void> {
    const { projects } = tables;
    if (change.paused !== undefined || change.blocked !== undefined) {
      await this.db
        .update(projects)
        .set(change)
        .where(and(eq(projects.scope, this.scope), eq(projects.id, id)));
    }
    await this.emit(null, "project", { id, ...change });
  }
  async insertRun(run: RunRecord): Promise<boolean> {
    const { runs } = tables;
    const inserted = await this.db
      .insert(runs)
      .values({
        scope: this.scope,
        id: run.id,
        taskKey: run.taskKey,
        attempt: run.attempt,
        record: redactValue(run, this.redact) as RunRecord,
      })
      .onConflictDoNothing()
      .returning({ id: runs.id });
    if (inserted.length) await this.emit(run.id, "run", run);
    return inserted.length > 0;
  }
  /**
   * Admit a retry and its events atomically. Safety checks run under the project
   * lock only for new admissions; they must not write through this Store.
   */
  async admitRetry(runId: string, admission: RetryAdmission): Promise<string> {
    const original = await this.run(runId);
    const { projects, runs, events } = tables;
    const projectPredicate = and(
      eq(projects.scope, this.scope),
      eq(projects.id, original.projectId),
    );
    return this.db.transaction(async (tx) => {
      // Lock the project, not just the original run: retries of different
      // attempts of the same task must compete for the same admission.
      const [project] = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(projectPredicate)
        .for("update");
      if (!project) throw new Error(`Unknown project: ${original.projectId}`);
      if (admission.commandId) {
        const [existing] = await tx
          .select({ record: runs.record })
          .from(runs)
          .where(
            and(eq(runs.scope, this.scope), eq(runs.id, admission.commandId)),
          );
        if (existing) {
          if (existing.record.retryOf !== runId)
            throw new Error(
              "Retry command identity belongs to a different run",
            );
          return existing.record.id;
        }
      }
      const history = await tx
        .select({ record: runs.record, attempt: runs.attempt })
        .from(runs)
        .where(
          and(eq(runs.scope, this.scope), eq(runs.taskKey, original.taskKey)),
        )
        .orderBy(runs.id)
        .for("update");
      const previous = history.find((row) => row.record.id === runId)?.record;
      if (!previous) throw new Error(`Unknown run: ${runId}`);
      if (!["failed", "blocked", "cancelled"].includes(previous.outcome))
        throw new Error(
          "Only failed, blocked or cancelled runs can be retried",
        );
      if (
        history.some(({ record }) =>
          ["queued", "running"].includes(record.outcome),
        )
      )
        throw new Error("This task already has a queued or active retry");
      const target = await admission.checkSafety(previous);
      const attempt = Math.max(...history.map((row) => row.attempt)) + 1;
      const id = admission.commandId ?? randomUUID();
      const now = new Date().toISOString();
      const retry = createQueuedRun({
        id,
        projectId: previous.projectId,
        checkout: target.checkout,
        taskKey: previous.taskKey,
        attempt,
        retryOf: previous.id,
        issue: previous.issue,
        now,
        branchTemplate: target.branchTemplate,
      });
      const persisted = redactValue(retry, this.redact) as RunRecord;
      // A conflict must fail admission, never return an unpersisted run ID.
      await tx.insert(runs).values({
        scope: this.scope,
        id,
        taskKey: retry.taskKey,
        attempt,
        record: persisted,
      });
      await tx.update(projects).set({ blocked: null }).where(projectPredicate);
      await tx.insert(events).values([
        {
          scope: this.scope,
          runId: null,
          kind: "project",
          payload: redactValue(
            { id: previous.projectId, blocked: null },
            this.redact,
          ),
        },
        { scope: this.scope, runId: id, kind: "run", payload: persisted },
      ]);
      return id;
    });
  }
  async run(id: string): Promise<RunRecord> {
    const { runs } = tables;
    const [row] = await this.db
      .select({ record: runs.record })
      .from(runs)
      .where(and(eq(runs.scope, this.scope), eq(runs.id, id)));
    if (!row) throw new Error(`Unknown run: ${id}`);
    return row.record;
  }
  async runs(): Promise<RunRecord[]> {
    const { runs } = tables;
    const rows = await this.db
      .select({ record: runs.record, attempt: runs.attempt, id: runs.id })
      .from(runs)
      .where(eq(runs.scope, this.scope));
    // This API returns the full scope; sort JSON fields here without raw SQL expressions.
    return rows
      .sort(
        (a, b) =>
          a.record.createdAt.localeCompare(b.record.createdAt) ||
          a.record.issue.number - b.record.issue.number ||
          a.attempt - b.attempt ||
          a.id.localeCompare(b.id),
      )
      .map((row) => row.record);
  }
  async patchRun(id: string, patch: Partial<RunRecord>): Promise<RunRecord> {
    const { runs } = tables;
    const change = { ...patch, updatedAt: new Date().toISOString() };
    const predicate = and(eq(runs.scope, this.scope), eq(runs.id, id));
    const record = await this.db.transaction(async (tx) => {
      // Serialize read/merge/write so concurrent patches cannot lose fields.
      const [row] = await tx
        .select({ record: runs.record })
        .from(runs)
        .where(predicate)
        .for("update");
      if (!row) throw new Error(`Unknown run: ${id}`);
      // Match JSON serialization: undefined patch fields leave stored fields intact.
      const persistedChange = JSON.parse(
        JSON.stringify(redactValue(change, this.redact)),
      ) as Partial<RunRecord>;
      const merged = { ...row.record, ...persistedChange };
      await tx.update(runs).set({ record: merged }).where(predicate);
      return merged;
    });
    await this.emit(id, "run", change);
    return record;
  }
  async saveInvocation(record: InvocationRecord): Promise<void> {
    const { invocations } = tables;
    const persisted = redactValue(record, this.redact) as InvocationRecord;
    await this.db
      .insert(invocations)
      .values({
        scope: this.scope,
        id: record.id,
        runId: record.runId,
        record: persisted,
      })
      .onConflictDoUpdate({
        target: invocations.id,
        set: { record: persisted },
      });
    await this.emit(record.runId, "invocation", record);
  }
  async invocations(runId: string): Promise<InvocationRecord[]> {
    const { invocations } = tables;
    const rows = await this.db
      .select({ record: invocations.record })
      .from(invocations)
      .where(
        and(eq(invocations.scope, this.scope), eq(invocations.runId, runId)),
      );
    return rows
      .map((row) => row.record)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }
  async emit(
    runId: string | null,
    kind: string,
    payload: unknown,
  ): Promise<void> {
    await this.db.insert(tables.events).values({
      scope: this.scope,
      runId,
      kind,
      // Bind serialized JSON so JSON null is not converted to SQL NULL.
      payload: new SQL([
        new Param(JSON.stringify(redactValue(payload, this.redact))),
      ]),
    });
  }
  async events(after = 0, runId?: string): Promise<EventRecord[]> {
    const { events } = tables;
    const rows = await this.db
      .select({
        sequence: events.sequence,
        runId: events.runId,
        kind: events.kind,
        payload: events.payload,
        createdAt: events.createdAt,
      })
      .from(events)
      .where(
        and(
          eq(events.scope, this.scope),
          gt(events.sequence, after),
          runId === undefined ? undefined : eq(events.runId, runId),
        ),
      )
      .orderBy(events.sequence)
      .limit(1000);
    return rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
    }));
  }
  subscribe(
    listener: (event: EventRecord) => void,
    options: { after?: number; intervalMs?: number } = {},
  ): () => void {
    let cursor = options.after ?? 0,
      closed = false,
      busy = false;
    const poll = async () => {
      if (closed || busy) return;
      busy = true;
      try {
        for (const event of await this.events(cursor)) {
          if (closed) break;
          listener(event);
          cursor = event.sequence;
        }
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => {
      void poll().catch(() => {
        /* Next poll retries; callers can query directly for errors. */
      });
    }, options.intervalMs ?? 500);
    void poll().catch(() => {});
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }
  async request(
    kind: "pause" | "resume" | "stop" | "retry",
    target: string,
  ): Promise<string> {
    const id = randomUUID();
    await this.db
      .insert(tables.commands)
      .values({ id, scope: this.scope, kind, target });
    return id;
  }
  async commands(): Promise<
    Array<{
      id: string;
      kind: string;
      target: string;
      status: string;
      error: string | null;
    }>
  > {
    const { commands } = tables;
    return this.db
      .select({
        id: commands.id,
        kind: commands.kind,
        target: commands.target,
        status: commands.status,
        error: commands.error,
      })
      .from(commands)
      .where(eq(commands.scope, this.scope))
      .orderBy(commands.createdAt);
  }
  async finishCommand(id: string, error?: string): Promise<void> {
    const { commands } = tables;
    await this.db
      .update(commands)
      .set({ status: error ? "failed" : "success", error: error ?? null })
      .where(and(eq(commands.scope, this.scope), eq(commands.id, id)));
  }
}
