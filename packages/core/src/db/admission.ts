import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { RunRecord } from "../domain.js";
import { redactValue } from "../runtime/redaction.js";
import * as tables from "./schema.js";

export type AdmissionTransaction = Parameters<
  Parameters<NodePgDatabase["transaction"]>[0]
>[0];
export interface AdmissionHistory {
  record: RunRecord;
  attempt: number;
}

export function hasActiveAttempt(runs: RunRecord[]): boolean {
  return runs.some((run) => ["queued", "running"].includes(run.outcome));
}
export function nextAttempt(history: AdmissionHistory[]): number {
  return Math.max(0, ...history.map((row) => row.attempt)) + 1;
}

/**
 * Steps shared by every transaction that admits a Run attempt: the project lock
 * that serializes competing admissions, task history, and redacted persistence
 * with its events.
 */
export class RunAdmission {
  constructor(
    private readonly scope: string,
    private readonly redact: (text: string) => string,
  ) {}
  private projectPredicate(projectId: string) {
    return and(
      eq(tables.projects.scope, this.scope),
      eq(tables.projects.id, projectId),
    );
  }
  /** Lock the project, not just a task: admissions for one project must compete. */
  async lockProject(tx: AdmissionTransaction, projectId: string) {
    const [project] = await tx
      .select()
      .from(tables.projects)
      .where(this.projectPredicate(projectId))
      .for("update");
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    return project;
  }
  /** Every attempt of a task in attempt order, locked for this admission. */
  async history(
    tx: AdmissionTransaction,
    taskKey: string,
  ): Promise<AdmissionHistory[]> {
    return tx
      .select({ record: tables.runs.record, attempt: tables.runs.attempt })
      .from(tables.runs)
      .where(
        and(
          eq(tables.runs.scope, this.scope),
          eq(tables.runs.taskKey, taskKey),
        ),
      )
      .orderBy(tables.runs.attempt)
      .for("update");
  }
  async projectRuns(
    tx: AdmissionTransaction,
    projectId: string,
  ): Promise<RunRecord[]> {
    return (
      await tx
        .select({ record: tables.runs.record })
        .from(tables.runs)
        .where(eq(tables.runs.scope, this.scope))
    )
      .map((row) => row.record)
      .filter((run) => run.projectId === projectId);
  }
  /**
   * Persist a new attempt redacted, optionally lift the project block, and
   * record its events. A conflict fails admission; it never returns an
   * unpersisted run.
   */
  async insert(
    tx: AdmissionTransaction,
    run: RunRecord,
    options: {
      unblock: boolean;
      events?: Array<{ kind: string; payload: unknown }>;
    },
  ): Promise<RunRecord> {
    const persisted = redactValue(run, this.redact) as RunRecord;
    await tx.insert(tables.runs).values({
      scope: this.scope,
      id: run.id,
      taskKey: run.taskKey,
      attempt: run.attempt,
      record: persisted,
    });
    const events: Array<{
      runId: string | null;
      kind: string;
      payload: unknown;
    }> = [];
    if (options.unblock) {
      await tx
        .update(tables.projects)
        .set({ blocked: null })
        .where(this.projectPredicate(run.projectId));
      events.push({
        runId: null,
        kind: "project",
        payload: { id: run.projectId, blocked: null },
      });
    }
    events.push(
      { runId: run.id, kind: "run", payload: persisted },
      ...(options.events ?? []).map((event) => ({ ...event, runId: run.id })),
    );
    await tx.insert(tables.events).values(
      events.map((event) => ({
        scope: this.scope,
        runId: event.runId,
        kind: event.kind,
        payload: redactValue(event.payload, this.redact),
      })),
    );
    return persisted;
  }
}
