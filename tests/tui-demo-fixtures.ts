import assert from "node:assert/strict";
import type { MonitorSource } from "../packages/cli/src/tui/index.js";
import type { RunRecord } from "../packages/core/src/domain.js";
import type { InvocationRecord } from "../packages/core/src/store.js";
import { monitorFixture } from "./tui-fixtures.js";

/** Coherent, isolated operator scenarios. No database, provider or remote writes. */
export function consoleFixture(now = Date.now()) {
  const { run: template, sessions: templateSessions } = monitorFixture();
  assert.ok(template.subject.kind !== "local");
  const issueSubject = template.subject;
  const at = (seconds: number) => new Date(now - seconds * 1000).toISOString();
  const makeRun = (
    index: number,
    outcome: RunRecord["outcome"],
    phase: string,
    title: string,
  ): RunRecord => {
    const id = `demo-run-${index}`;
    const finishedAt = ["running", "queued"].includes(outcome)
      ? undefined
      : at(10);
    return {
      ...template,
      id,
      taskKey: `demo-task-${index}`,
      subject: {
        ...issueSubject,
        number: index,
        title,
        url: `https://example.test/issues/${index}`,
      },
      outcome,
      phase,
      createdAt: at(160),
      updatedAt: finishedAt ?? at(2),
      branch: `agent/${index}`,
      executions: [
        {
          id,
          fingerprint: "demo-fingerprint",
          recoverySupported: true,
          createdAt: at(160),
          startedAt: outcome === "queued" ? undefined : at(150),
          finishedAt,
          outcome,
          phase,
        },
      ],
    };
  };
  const running = makeRun(
    43,
    "running",
    "implementation",
    "Load CLI environment files for runner and workflow steps",
  );
  const publication = makeRun(
    42,
    "failed",
    "change-request",
    "Publish validated change request",
  );
  publication.error =
    "Resource not accessible by personal access token.\nHTTP 403 while creating the change request. Check repository access before recovery.";
  publication.base = "base-revision";
  publication.head = "committed-revision";
  publication.snapshot = {
    branch: publication.branch,
    head: publication.head,
    fingerprint: "demo",
    paths: [],
    files: {},
  };
  publication.publication = {
    commitMessage: "Implement feature",
    title: publication.subject.title,
    description: "Validated local change",
  };
  publication.executions![0]!.failedStep = 8;
  const validation = makeRun(
    44,
    "failed",
    "validation",
    "Validate authorization boundaries",
  );
  validation.error =
    "Configured check failed: permission test returned exit 1.";
  validation.validationStatus = "failed";
  validation.validation = [
    {
      command: "pnpm",
      args: ["test", "--filter", "permissions"],
      exitCode: 1,
      log: "",
      startedAt: at(30),
      finishedAt: at(10),
    },
  ];
  const blocked = makeRun(
    45,
    "blocked",
    "preparation",
    "Prepare checkout for queued issue",
  );
  blocked.error =
    "Checkout contains uncommitted changes; preserve or commit local work before retry.";
  const draft = makeRun(
    46,
    "completed",
    "change-request",
    "Deliver reviewed draft with limitations",
  );
  draft.readiness = {
    draft: true,
    reasons: ["Blocking review findings remain"],
  };
  draft.change = {
    id: 146,
    url: "https://example.test/pull/146",
    head: "draft-revision",
  };
  draft.review = {
    complete: false,
    summary: "Authorization review incomplete",
    findings: [
      {
        priority: "P1",
        body: "Authorization missing",
        path: "api.ts",
        line: 12,
      },
    ],
    limitations: ["External integration not inspected"],
  };
  draft.agentReport = {
    summary: "Implemented",
    validation: [
      {
        command: "manual smoke",
        outcome: "not-run",
        details: "Service unavailable",
      },
    ],
    limitations: ["Integration service unavailable"],
  };
  const old = makeRun(47, "failed", "push", "Publish an earlier attempt");
  old.error = "Push failed on an earlier attempt";
  old.base = publication.base;
  old.head = publication.head;
  old.snapshot = { ...publication.snapshot!, branch: old.branch };
  old.publication = { ...publication.publication! };
  old.executions![0]!.failedStep = 8;
  const retry = makeRun(48, "running", "implementation", old.subject.title);
  retry.subject = { ...old.subject };
  retry.taskKey = old.taskKey;
  retry.attempt = 2;
  retry.retryOf = old.id;
  const superseded = makeRun(
    49,
    "superseded",
    "review-publication",
    "Review target changed during publication",
  );
  superseded.error = "Review superseded: target revisions changed";
  const unicode = makeRun(
    50,
    "cancelled",
    "implementation",
    "修复权限检查 / café / 👩🏽‍💻 Unicode and a deliberately long subject with matching prefix and distinct ending",
  );
  const queued = makeRun(
    51,
    "queued",
    "eligibility",
    "Wait for project intake",
  );
  const runs = [
    running,
    publication,
    validation,
    blocked,
    draft,
    old,
    retry,
    superseded,
    unicode,
    queued,
    ...Array.from({ length: 10 }, (_, i) =>
      makeRun(
        60 + i,
        "completed",
        "change-request",
        `Completed pipeline ${i + 1}`,
      ),
    ),
  ];
  const other = makeRun(
    72,
    "running",
    "review",
    "Review another project's change request",
  );
  other.projectId = "web-service";
  assert.ok(other.subject.kind !== "local");
  other.subject = {
    ...other.subject,
    kind: "change-request",
    change: { id: 72, url: "https://example.test/pull/72", head: "head" },
    base: "base",
    start: "base",
    sourceBranch: "feature",
    targetBranch: "main",
    draft: false,
    fork: false,
  };
  runs.push(other);
  const sessions: InvocationRecord[] = [running, retry, other].map((run) => ({
    ...templateSessions[0]!,
    id: `${run.id}-invocation`,
    runId: run.id,
    executionId: run.id,
    projectId: run.projectId,
    startedAt: at(148),
    log: "",
    step: run.phase,
  }));
  const commands: Awaited<ReturnType<MonitorSource["commands"]>> = [];
  const source: MonitorSource = {
    projects: async () => [
      { id: "demo", paused: false, blocked: null },
      { id: "web-service", paused: false, blocked: null },
    ],
    runs: async () => runs,
    invocations: async (id) =>
      sessions.filter((session) => session.runId === id),
    events: async (after = 0, id) =>
      runs
        .filter((run) => run.id === id)
        .flatMap((run) =>
          after < 1
            ? [
                {
                  sequence: 1,
                  runId: run.id,
                  kind: "step",
                  payload: {
                    name: run.phase,
                    status: run.outcome,
                    executionId: run.id,
                  },
                  createdAt: at(2),
                },
              ]
            : [],
        ),
    commands: async () => commands,
    request: async () => {
      throw new Error("Read-only demonstration; no workflow actions are sent");
    },
  };
  return { source, runs, sessions, commands };
}
