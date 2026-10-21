import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import type { Project } from "../config.js";
import {
  hasActiveAttempt,
  nextAttempt,
  type RunAdmission,
} from "../db/admission.js";
import * as tables from "../db/schema.js";
import { BlockedError, type RunRecord } from "../domain.js";
import { createQueuedWorkRun } from "../run-record.js";
import { redactValue } from "../runtime/redaction.js";
import {
  ApprovalForbiddenError,
  WorkConflictError,
  WorkItemNotFoundError,
} from "./errors.js";
import {
  contentRevision,
  evaluateWork,
  gateRevision,
  sourceIsStale,
  sourceKey,
  workRevision,
} from "./policy.js";
import {
  type ApprovalGate,
  type ApprovalRecord,
  type WorkDecision,
  type WorkItem,
  type WorkSource,
  workContractSchema,
  workSourceSchema,
} from "./schema.js";

export interface WorkInspection {
  work: WorkItem;
  approvals: ApprovalRecord[];
  decision: WorkDecision;
}
export class WorkStore {
  private readonly db;
  constructor(
    pool: Pool,
    private readonly scope: string,
    private readonly redact: (text: string) => string,
    private readonly admission: RunAdmission,
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
  /**
   * Intake is idempotent on the source identity: an existing item keeps its
   * contract and observes the given source, which can change its revision.
   */
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
    const stored = await this.db.transaction(async (tx) => {
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
    return stored.id === work.id
      ? stored
      : this.refreshSource(stored.id, source);
  }
  async get(id: string): Promise<WorkItem> {
    const [row] = await this.db
      .select()
      .from(tables.workItems)
      .where(this.predicate(id));
    if (!row) throw new WorkItemNotFoundError(`Unknown work item: ${id}`);
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
    return this.approvalsIn(this.db, id);
  }
  private async approvalsIn(
    db: Pick<NodePgDatabase, "select">,
    id: string,
  ): Promise<ApprovalRecord[]> {
    const rows = await db
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
  async inspect(id: string, project: Project): Promise<WorkInspection> {
    const work = await this.get(id);
    if (work.projectId !== project.id)
      throw new WorkItemNotFoundError("Work item belongs to another project");
    const approvals = await this.approvals(id);
    return {
      work,
      approvals,
      decision: evaluateWork(work, approvals, project.sdlc),
    };
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
      if (!row) throw new WorkItemNotFoundError(`Unknown work item: ${id}`);
      if (row.record.revision !== expectedRevision)
        throw new WorkConflictError(
          "Work revision changed; inspect before proposing",
        );
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
      if (!row) throw new WorkItemNotFoundError(`Unknown work item: ${id}`);
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
      throw new ApprovalForbiddenError("Approval attribution is required");
    if (operator.source !== project.sdlc.approvalSource)
      throw new ApprovalForbiddenError("Approval source does not match policy");
    if (
      project.sdlc.approvers.length &&
      !project.sdlc.approvers.includes(operator.approvedBy)
    )
      throw new ApprovalForbiddenError("Operator is not an allowed approver");
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(tables.workItems)
        .where(this.predicate(id))
        .for("update");
      if (!row || row.record.projectId !== project.id)
        throw new WorkItemNotFoundError("Unknown work item for project");
      const work = row.record;
      if (work.revision !== expectedRevision)
        throw new WorkConflictError(
          "Work revision changed; inspect before approving",
        );
      if (sourceIsStale(work))
        throw new WorkConflictError(
          "Source changed; reassess before approving",
        );
      if (gate === "design" && !work.contract.design)
        throw new WorkConflictError(
          "Design is required before design approval",
        );
      const existing = await this.approvalsIn(tx, id);
      const repeated = existing.find(
        (item) =>
          item.gate === gate &&
          item.revision === gateRevision(work.contract, gate) &&
          item.approvedBy === operator.approvedBy &&
          item.source === operator.source &&
          item.evidence === operator.evidence,
      );
      if (repeated) return repeated;
      if (evaluateWork(work, existing, project.sdlc).awaitingGate !== gate)
        throw new WorkConflictError(`Work is not awaiting ${gate} approval`);
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
  /**
   * Admit the exact revision as a Run. Replaying an admitted revision returns
   * its latest attempt. A blocked project is admitted only with `recovery`,
   * whose safety check runs under the project lock and must not write.
   */
  async submit(
    id: string,
    expectedRevision: string,
    project: Project,
    recovery?: { checkSafety: (related: RunRecord[]) => Promise<void> },
  ): Promise<RunRecord> {
    if (!project.sdlc.enabled || !project.workflows.implementation.enabled)
      throw new Error("SDLC implementation is disabled");
    return this.db.transaction(async (tx) => {
      const state = await this.admission.lockProject(tx, project.id);
      if ((state.paused && !state.blocked) || (state.blocked && !recovery))
        throw new BlockedError("Project is paused or blocked");
      const [row] = await tx
        .select()
        .from(tables.workItems)
        .where(this.predicate(id))
        .for("update");
      if (!row || row.record.projectId !== project.id)
        throw new WorkItemNotFoundError("Unknown work item for project");
      const work = row.record;
      if (work.revision !== expectedRevision)
        throw new WorkConflictError(
          "Work revision changed; inspect before submitting",
        );
      if (work.source.kind === "local" && !project.sdlc.allowLocalTasks)
        throw new BlockedError("Local work is disabled by policy");
      if (sourceIsStale(work))
        throw new BlockedError("Source changed; reassess before submitting");
      const decision = evaluateWork(
        work,
        await this.approvalsIn(tx, id),
        project.sdlc,
      );
      if (decision.state !== "ready")
        throw new BlockedError(
          decision.reasons.map((reason) => reason.message).join("; "),
        );
      const history = await this.admission.history(tx, `work:${id}`);
      // Retries pin the same revision, so the latest attempt is the answer.
      const same = history.findLast(
        (item) => item.record.work?.revision === work.revision,
      );
      if (same) return same.record;
      if (hasActiveAttempt(history.map((item) => item.record)))
        throw new BlockedError("Work already has an active run");
      if (state.blocked) {
        const related = await this.admission.projectRuns(tx, project.id);
        if (hasActiveAttempt(related))
          throw new BlockedError("Project still has queued or active work");
        await recovery!.checkSafety(related);
      }
      const run = createQueuedWorkRun(work, project, nextAttempt(history));
      return this.admission.insert(tx, run, {
        unblock: state.blocked !== null,
        events: [
          {
            kind: "work-submitted",
            payload: {
              workItemId: id,
              revision: work.revision,
              track: decision.track,
            },
          },
        ],
      });
    });
  }
}
