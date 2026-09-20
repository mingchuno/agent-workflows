import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentAdapter,
  ChangeRequest,
  HostingAdapter,
  Issue,
} from "../src/domain.js";
export class FixtureHosting implements HostingAdapter {
  identity = "https://fixture.invalid/a/b";
  changes: ChangeRequest[] = [];
  branches = new Map<string, ChangeRequest>();
  reviews: string[] = [];
  issues: Issue[] = [
    {
      id: "1",
      number: 1,
      title: "Add a file",
      body: "Implement the task",
      url: "https://fixture.invalid/1",
      labels: ["ready-for-agent"],
      open: true,
    },
  ];
  async listIssues() {
    return this.issues;
  }
  async getIssue(number: number) {
    return this.issues.find((i) => i.number === number)!;
  }
  async findChange(branch: string) {
    return this.branches.get(branch);
  }
  async createChange(input: Parameters<HostingAdapter["createChange"]>[0]) {
    const change = {
      id: this.changes.length + 1,
      url: "https://fixture.invalid/pr/1",
      head: input.head,
    };
    this.changes.push(change);
    this.branches.set(input.branch, change);
    return change;
  }
  async head(change: ChangeRequest) {
    return change.head;
  }
  async publishReview(input: Parameters<HostingAdapter["publishReview"]>[0]) {
    if (!this.reviews.includes(input.runId)) this.reviews.push(input.runId);
  }
}
export const agent: AgentAdapter = {
  async validate(profile) {
    return {
      provider: profile.provider,
      model: profile.model ?? "unknown",
      reasoningEffort: "unknown",
      context: "unknown",
      contextWindowTokens: "unknown",
    };
  },
  async invoke(invocation) {
    await invocation.session(randomUUID());
    if (invocation.step === "implementation") {
      await writeFile(join(invocation.cwd, "implemented.txt"), "implemented\n");
      return "done";
    }
    if (invocation.step === "publication")
      return JSON.stringify({
        commitMessage: "feat: implement issue",
        title: "Implemented issue",
        description: "Adds requested file. No validation configured.",
      });
    return JSON.stringify({
      complete: true,
      limitations: [],
      summary: "Reviewed exact revision",
      findings: [],
    });
  },
};
export async function waitFor(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 20000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for outcome");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
