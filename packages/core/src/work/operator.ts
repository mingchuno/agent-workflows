import { userInfo } from "node:os";
import type { Project } from "../config.js";
import type { RunRecord } from "../domain.js";
import type { Store } from "../store.js";
import { ApprovalForbiddenError, WorkItemNotFoundError } from "./errors.js";
import type { ApprovalGate, SdlcPolicy } from "./schema.js";
import type { WorkInspection } from "./store.js";

export interface WorkItemView extends WorkInspection {
  approvalSource: SdlcPolicy["approvalSource"];
  runIds: string[];
}
export interface WorkOperator {
  list(): Promise<WorkItemView[]>;
  inspect(id: string): Promise<WorkItemView>;
  /** Record local human approval of the inspected revision. */
  approve(
    id: string,
    approval: { gate: ApprovalGate; revision: string },
  ): Promise<WorkItemView>;
}

/**
 * Operator actions on Work Items for an interactive surface (CLI, terminal or
 * web monitor). Items outside `projects` are reported as not found. Store
 * errors keep their kinds: WorkItemNotFoundError, ApprovalForbiddenError and
 * WorkConflictError.
 */
export function workOperator(options: {
  store: Store;
  /** SDLC-enabled projects the surface exposes; read on every call. */
  projects: () => Promise<Project[]>;
  /** Approver identity; defaults to the local OS user. */
  operator?: string;
}): WorkOperator {
  const { store } = options;
  const view = async (
    id: string,
    project: Project,
    runs?: RunRecord[],
  ): Promise<WorkItemView> => ({
    ...(await store.workItems.inspect(id, project)),
    approvalSource: project.sdlc.approvalSource,
    runIds: (runs ?? (await store.runs()))
      .filter(
        (run) => run.projectId === project.id && run.work?.workItemId === id,
      )
      .map((run) => run.id),
  });
  const projectFor = async (id: string): Promise<Project> => {
    const work = await store.workItems.get(id);
    const project = (await options.projects()).find(
      (item) => item.id === work.projectId && item.sdlc.enabled,
    );
    if (!project) throw new WorkItemNotFoundError(`Unknown work item: ${id}`);
    return project;
  };
  return {
    async list() {
      const runs = await store.runs();
      const items: WorkItemView[] = [];
      for (const project of await options.projects()) {
        if (!project.sdlc.enabled) continue;
        for (const work of await store.workItems.list(project.id))
          items.push(await view(work.id, project, runs));
      }
      return items;
    },
    async inspect(id) {
      return view(id, await projectFor(id));
    },
    async approve(id, approval) {
      const project = await projectFor(id);
      if (project.sdlc.approvalSource !== "local-operator")
        throw new ApprovalForbiddenError(
          "This project requires authenticated allowed-human approval through its configured host",
        );
      await store.workItems.approve(
        id,
        approval.revision,
        approval.gate,
        {
          approvedBy: options.operator ?? userInfo().username,
          source: "local-operator",
        },
        project,
      );
      return view(id, project);
    },
  };
}
