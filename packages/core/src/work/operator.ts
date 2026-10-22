import { userInfo } from "node:os";
import { createHosting } from "../adapters/hosting.js";
import type { Project } from "../config.js";
import {
  BlockedError,
  type HostingAdapter,
  type RunRecord,
} from "../domain.js";
import type { Store } from "../store.js";
import { assertCheckoutReleased } from "../workspace.js";
import { admitWork } from "./admission.js";
import { ApprovalForbiddenError, WorkItemNotFoundError } from "./errors.js";
import type { ApprovalGate, SdlcPolicy } from "./schema.js";
import type { WorkInspection } from "./store.js";

export interface WorkItemView extends WorkInspection {
  approvalSource: SdlcPolicy["approvalSource"];
  runIds: string[];
  /** Ready work in a project blocked by escalation; an operator may resubmit it. */
  recoverable: boolean;
}
export interface WorkOperator {
  list(): Promise<WorkItemView[]>;
  inspect(id: string): Promise<WorkItemView>;
  /** Record local human approval of the inspected revision. */
  approve(
    id: string,
    approval: { gate: ApprovalGate; revision: string },
  ): Promise<WorkItemView>;
  /**
   * Admit the inspected ready revision into a blocked project after checking
   * that earlier processes stopped and the checkout is clean.
   */
  resubmit(id: string, revision: string): Promise<WorkItemView>;
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
  /** Absolute state directory; required for `resubmit`. */
  stateDirectory?: string;
  hosting?: (project: Project) => HostingAdapter;
}): WorkOperator {
  const { store } = options;
  const view = async (
    id: string,
    project: Project,
    runs?: RunRecord[],
  ): Promise<WorkItemView> => {
    const inspection = await store.workItems.inspect(id, project);
    return {
      ...inspection,
      approvalSource: project.sdlc.approvalSource,
      runIds: (runs ?? (await store.runs()))
        .filter(
          (run) => run.projectId === project.id && run.work?.workItemId === id,
        )
        .map((run) => run.id),
      recoverable:
        inspection.decision.state === "ready" &&
        (await store.project(project.id)).blocked !== null,
    };
  };
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
    async resubmit(id, revision) {
      const project = await projectFor(id);
      const stateDirectory = options.stateDirectory;
      if (!stateDirectory)
        throw new Error("Resubmission is unavailable from this surface");
      const admission = await admitWork(
        id,
        project,
        {
          store,
          hosting: () => (options.hosting ?? createHosting)(project),
        },
        {
          revision,
          recovery: {
            checkSafety: (related) =>
              assertCheckoutReleased({
                project,
                stateDirectory,
                runIds: related.map((run) => run.id),
              }),
          },
        },
      );
      if (admission.state === "waiting")
        throw new BlockedError(admission.reason);
      return view(id, project);
    },
  };
}
