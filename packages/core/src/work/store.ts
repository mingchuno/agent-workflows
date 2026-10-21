import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import type { Project } from "../config.js";
import * as tables from "../db/schema.js";
import { BlockedError, type Issue, type RunRecord } from "../domain.js";
import { createQueuedWorkRun } from "../run-record.js";
import { redactValue } from "../runtime/redaction.js";
import {
  assessReadiness,
  contentRevision,
  gateRevision,
  workRevision,
} from "./policy.js";
import {
  type ApprovalGate,
  type ApprovalRecord,
  type WorkItem,
  type WorkSource,
  workContractSchema,
  workSourceSchema,
} from "./schema.js";

export function issueRevision(issue: Issue): string {
  return contentRevision({
    id: issue.id,
    number: issue.number,
    url: issue.url,
    title: issue.title,
    body: issue.body,
  });
}
export function issueSource(
  provider: "github" | "gitlab",
  issue: Issue,
): WorkSource {
  return {
    kind: provider,
    issueId: issue.id,
    number: issue.number,
    url: issue.url,
    revision: issueRevision(issue),
  };
}
export function sourceKey(source: WorkSource): string {
  return source.kind === "local"
    ? `local:${source.key}`
    : `${source.kind}:${source.issueId}`;
}
export class WorkStore {
  private readonly db;
  constructor(
    pool: Pool,
    private readonly scope: string,
    private readonly redact: (text: string) => string,
  ) {
    this.db = drizzle(pool);
  }
  private predicate(id: string) {
    return and(
      eq(tables.workItems.scope, this.scope),
      eq(tables.workItems.id, id),
    );
  }
  private event(kind: string, payload: unknown, runId: string | null = null) {
    return {
      scope: this.scope,
      runId,
      kind,
      payload: redactValue(payload, this.redact),
    };
  }
  private contract(input: unknown, source: WorkSource) {
    return workContractSchema.parse(
      redactValue(
        {
          ...workContractSchema.parse(input),
          sourceRevision: source.kind === "local" ? undefined : source.revision,
        },
        this.redact,
      ),
    );
  }
  async create(
    projectId: string,
    inputSource: WorkSource,
    input: unknown,
  ): Promise<WorkItem> {
    const source = workSourceSchema.parse(inputSource);
    const contract = this.contract(input, source);
    const now = new Date().toISOString();
    const work: WorkItem = {
      id: randomUUID(),
      projectId,
      source,
      contract,
      revision: workRevision(contract, source),
      createdAt: now,
      updatedAt: now,
    };
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(tables.workItems)
        .values({
          scope: this.scope,
          id: work.id,
          projectId,
          sourceKey: sourceKey(source),
          record: work,
        })
        .onConflictDoNothing()
        .returning();
      if (!inserted.length) {
        const [existing] = await tx
          .select()
          .from(tables.workItems)
          .where(
            and(
              eq(tables.workItems.scope, this.scope),
              eq(tables.workItems.projectId, projectId),
              eq(tables.workItems.sourceKey, sourceKey(source)),
            ),
          );
        if (!existing) throw new Error("Work intake conflict");
        return existing.record;
      }
      await tx.insert(tables.events).values(this.event("work-created", work));
      return work;
    });
  }
  async get(id: string): Promise<WorkItem> {
    const [row] = await this.db
      .select()
      .from(tables.workItems)
      .where(this.predicate(id));
    if (!row) throw new Error(`Unknown work item: ${id}`);
    return row.record;
  }
  async list(projectId?: string): Promise<WorkItem[]> {
    const rows = await this.db
      .select()
      .from(tables.workItems)
      .where(
        and(
          eq(tables.workItems.scope, this.scope),
          projectId === undefined
            ? undefined
            : eq(tables.workItems.projectId, projectId),
        ),
      )
      .orderBy(tables.workItems.id);
    return rows.map((row) => row.record);
  }
  async approvals(id: string): Promise<ApprovalRecord[]> {
    const rows = await this.db
      .select()
      .from(tables.workApprovals)
      .where(
        and(
          eq(tables.workApprovals.scope, this.scope),
          eq(tables.workApprovals.workItemId, id),
        ),
      )
      .orderBy(tables.workApprovals.id);
    return rows.map((row) => row.record);
  }
  async inspect(id: string, project: Project) {
    const work = await this.get(id);
    if (work.projectId !== project.id)
      throw new Error("Work item belongs to another project");
    const approvals = await this.approvals(id);
    const decision = assessReadiness(work.contract, approvals, project.sdlc);
    if (
      work.source.kind !== "local" &&
      work.contract.sourceRevision !== work.source.revision
    ) {
      decision.state = "needs-info";
      decision.reasons.push({
        code: "uncertainty",
        message: "Hosted issue changed; explicitly reassess the current source",
      });
    }
    return { work, approvals, decision };
  }
  async propose(
    id: string,
    expectedRevision: string,
    input: unknown,
  ): Promise<WorkItem> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(tables.workItems)
        .where(this.predicate(id))
        .for("update");
      if (!row) throw new Error(`Unknown work item: ${id}`);
      if (row.record.revision !== expectedRevision)
        throw new Error("Work revision changed; inspect before proposing");
      const contract = this.contract(input, row.record.source);
      const work: WorkItem = {
        ...row.record,
        contract,
        revision: workRevision(contract, row.record.source),
        updatedAt: new Date().toISOString(),
      };
      await tx
        .update(tables.workItems)
        .set({ record: work })
        .where(this.predicate(id));
      await tx.insert(tables.events).values(
        this.event("work-proposed", {
          workItemId: id,
          revision: work.revision,
        }),
      );
      return work;
    });
  }
  async refreshSource(id: string, source: WorkSource): Promise<WorkItem> {
    source = workSourceSchema.parse(source);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(tables.workItems)
        .where(this.predicate(id))
        .for("update");
      if (!row) throw new Error(`Unknown work item: ${id}`);
      if (sourceKey(row.record.source) !== sourceKey(source))
        throw new Error("Source identity differs from work item");
      if (contentRevision(row.record.source) === contentRevision(source))
        return row.record;
      const work = {
        ...row.record,
        source,
        revision: workRevision(row.record.contract, source),
        updatedAt: new Date().toISOString(),
      };
      await tx
        .update(tables.workItems)
        .set({ record: work })
        .where(this.predicate(id));
      await tx
        .insert(tables.events)
        .values(this.event("work-source-changed", { workItemId: id, source }));
      return work;
    });
  }
  async approve(
    id: string,
    expectedRevision: string,
    gate: ApprovalGate,
    operator: {
      approvedBy: string;
      source: ApprovalRecord["source"];
      evidence?: string;
    },
    project: Project,
  ): Promise<ApprovalRecord> {
    if (!operator.approvedBy.trim())
      throw new Error("Approval attribution is required");
    if (operator.source !== project.sdlc.approvalSource)
      throw new Error("Approval source does not match policy");
    if (
      project.sdlc.approvers.length &&
      !project.sdlc.approvers.includes(operator.approvedBy)
    )
      throw new Error("Operator is not an allowed approver");
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(tables.workItems)
        .where(this.predicate(id))
        .for("update");
      if (!row || row.record.projectId !== project.id)
        throw new Error("Unknown work item for project");
      const work = row.record;
      if (work.revision !== expectedRevision)
        throw new Error("Work revision changed; inspect before approving");
      if (
        work.source.kind !== "local" &&
        work.contract.sourceRevision !== work.source.revision
      )
        throw new Error("Source changed; reassess before approving");
      if (gate === "design" && !work.contract.design)
        throw new Error("Design is required before design approval");
      const existing = await tx
        .select()
        .from(tables.workApprovals)
        .where(
          and(
            eq(tables.workApprovals.scope, this.scope),
            eq(tables.workApprovals.workItemId, id),
          ),
        );
      const repeated = existing.find(
        (item) =>
          item.record.gate === gate &&
          item.record.revision === gateRevision(work.contract, gate) &&
          item.record.approvedBy === operator.approvedBy &&
          item.record.source === operator.source &&
          item.record.evidence === operator.evidence,
      );
      if (repeated) return repeated.record;
      const decision = assessReadiness(
        work.contract,
        existing.map((item) => item.record),
        project.sdlc,
      );
      if (
        decision.state !==
        (gate === "scope"
          ? "awaiting-scope-approval"
          : "awaiting-design-approval")
      )
        throw new Error(`Work is not awaiting ${gate} approval`);
      const approval: ApprovalRecord = {
        id: randomUUID(),
        workItemId: id,
        gate,
        revision: gateRevision(work.contract, gate),
        approvedAt: new Date().toISOString(),
        ...operator,
      };
      await tx.insert(tables.workApprovals).values({
        scope: this.scope,
        id: approval.id,
        workItemId: id,
        record: approval,
      });
      await tx
        .insert(tables.events)
        .values(this.event("work-approved", approval));
      return approval;
    });
  }
  async submit(
    id: string,
    expectedRevision: string,
    project: Project,
    recovery?: { checkSafety: (history: RunRecord[]) => Promise<void> },
  ): Promise<RunRecord> {
    if (!project.sdlc.enabled || !project.workflows.implementation.enabled)
      throw new Error("SDLC implementation is disabled");
    return this.db.transaction(async (tx) => {
      const [state] = await tx
        .select()
        .from(tables.projects)
        .where(
          and(
            eq(tables.projects.scope, this.scope),
            eq(tables.projects.id, project.id),
          ),
        )
        .for("update");
      if (!state) throw new Error("Project is not registered");
      if ((state.paused && !state.blocked) || (state.blocked && !recovery))
        throw new BlockedError("Project is paused or blocked");
      const [row] = await tx
        .select()
        .from(tables.workItems)
        .where(this.predicate(id))
        .for("update");
      if (!row || row.record.projectId !== project.id)
        throw new Error("Unknown work item for project");
      const work = row.record;
      if (work.revision !== expectedRevision)
        throw new Error("Work revision changed; inspect before submitting");
      if (work.source.kind === "local" && !project.sdlc.allowLocalTasks)
        throw new BlockedError("Local work is disabled by policy");
      if (
        work.source.kind !== "local" &&
        work.contract.sourceRevision !== work.source.revision
      )
        throw new BlockedError("Source changed; reassess before submitting");
      const approvalRows = await tx
        .select()
        .from(tables.workApprovals)
        .where(
          and(
            eq(tables.workApprovals.scope, this.scope),
            eq(tables.workApprovals.workItemId, id),
          ),
        );
      const decision = assessReadiness(
        work.contract,
        approvalRows.map((item) => item.record),
        project.sdlc,
      );
      if (decision.state !== "ready")
        throw new BlockedError(
          decision.reasons.map((reason) => reason.message).join("; "),
        );
      const history = await tx
        .select()
        .from(tables.runs)
        .where(
          and(
            eq(tables.runs.scope, this.scope),
            eq(tables.runs.taskKey, `work:${id}`),
          ),
        )
        .orderBy(tables.runs.attempt);
      const same = history.find(
        (item) => item.record.work?.revision === work.revision,
      );
      if (same) return same.record;
      if (
        history.some((item) =>
          ["queued", "running"].includes(item.record.outcome),
        )
      )
        throw new BlockedError("Work already has an active run");
      if (state.blocked) {
        const related = (
          await tx
            .select()
            .from(tables.runs)
            .where(
              and(
                eq(tables.runs.scope, this.scope),
                sql`${tables.runs.record}->>'projectId' = ${project.id}`,
              ),
            )
        ).map((item) => item.record);
        if (related.some((run) => ["queued", "running"].includes(run.outcome)))
          throw new BlockedError("Project still has queued or active work");
        await recovery!.checkSafety(related);
        await tx
          .update(tables.projects)
          .set({ blocked: null })
          .where(
            and(
              eq(tables.projects.scope, this.scope),
              eq(tables.projects.id, project.id),
            ),
          );
        await tx
          .insert(tables.events)
          .values(this.event("project", { id: project.id, blocked: null }));
      }
      const run = createQueuedWorkRun(
        work,
        project,
        (history.at(-1)?.attempt ?? 0) + 1,
      );
      await tx.insert(tables.runs).values({
        scope: this.scope,
        id: run.id,
        taskKey: run.taskKey,
        attempt: run.attempt,
        record: run,
      });
      await tx
        .insert(tables.events)
        .values([
          this.event("run", run, run.id),
          this.event(
            "work-submitted",
            { workItemId: id, revision: work.revision, track: decision.track },
            run.id,
          ),
        ]);
      return run;
    });
  }
}
