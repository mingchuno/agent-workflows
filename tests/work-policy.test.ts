import assert from "node:assert/strict";
import { test } from "node:test";
import { configSchema, projectSchema } from "../packages/core/src/config.js";
import { withDeliveryEvidence } from "../packages/core/src/publication-evidence.js";
import { createQueuedWorkRun } from "../packages/core/src/run-record.js";
import {
  assessReadiness,
  contractRevision,
  gateRevision,
  reassessChanges,
  resolveTrack,
} from "../packages/core/src/work/policy.js";
import {
  type ApprovalRecord,
  sdlcPolicySchema,
  workContractSchema,
} from "../packages/core/src/work/schema.js";

const policy = sdlcPolicySchema.parse({ enabled: true });
const contract = workContractSchema.parse({
  title: "Correct missing-size sorting",
  intent: "Files with missing sizes sort last",
  acceptanceCriteria: ["Missing sizes sort after numeric sizes"],
  scopePaths: ["src/sorting/**", "tests/sorting.test.ts"],
  verification: { strategy: "Regression test for missing and numeric sizes" },
  assessment: { proposedTrack: "A", complexity: "small" },
});
function approved(gate: "scope" | "design", value = contract): ApprovalRecord {
  return {
    id: gate,
    workItemId: "work-1",
    gate,
    revision: gateRevision(value, gate),
    approvedBy: "operator",
    approvedAt: "2026-10-21T00:00:00.000Z",
    source: "local-operator",
  };
}

test("risk floors cannot be downgraded by an agent recommendation", () => {
  assert.equal(resolveTrack(contract, policy).track, "A");
  assert.equal(
    resolveTrack(
      {
        ...contract,
        assessment: { ...contract.assessment, complexity: "moderate" },
      },
      policy,
    ).track,
    "B",
  );
  for (const flag of [
    "migration",
    "security",
    "breaking-api",
    "production",
  ] as const) {
    const value = {
      ...contract,
      assessment: { ...contract.assessment, riskFlags: [flag] },
    };
    assert.equal(resolveTrack(value, policy).track, "C");
  }
  const protectedPolicy = sdlcPolicySchema.parse({
    enabled: true,
    riskRules: [{ paths: ["db/migrations/**"], minimumTrack: "C" }],
  });
  assert.equal(
    resolveTrack(contract, protectedPolicy, ["db/migrations/001.sql"]).track,
    "C",
  );
  assert.equal(
    resolveTrack(
      {
        ...contract,
        assessment: {
          ...contract.assessment,
          uncertainties: ["Ordering direction unknown"],
        },
      },
      policy,
    ).track,
    "B",
  );
});

test("A needs an expected outcome; B and C require revision-bound human gates", () => {
  assert.equal(assessReadiness(contract, [], policy).state, "ready");
  assert.equal(
    assessReadiness({ ...contract, acceptanceCriteria: [] }, [], policy).state,
    "needs-info",
  );
  const standard = {
    ...contract,
    assessment: { ...contract.assessment, proposedTrack: "B" as const },
  };
  assert.equal(
    assessReadiness(standard, [], policy).state,
    "awaiting-scope-approval",
  );
  assert.equal(
    assessReadiness(standard, [approved("scope", standard)], policy).state,
    "ready",
  );
  const controlled = {
    ...standard,
    assessment: { ...standard.assessment, proposedTrack: "C" as const },
  };
  assert.equal(
    assessReadiness(controlled, [approved("scope", controlled)], policy).state,
    "design",
  );
  const designed = {
    ...controlled,
    design: {
      summary: "Change sorting only",
      alternatives: ["Keep existing comparator"],
      stages: ["Update comparator and regression tests"],
      verification: "Exercise all ordering directions",
      rollback: "Revert comparator change",
      references: [],
    },
  };
  assert.equal(
    assessReadiness(designed, [approved("scope", controlled)], policy).state,
    "awaiting-design-approval",
  );
  assert.equal(
    assessReadiness(
      designed,
      [approved("scope", controlled), approved("design", designed)],
      policy,
    ).state,
    "ready",
  );
});

test("approval hashing is canonical and design authoring preserves scope approval", () => {
  const reordered = Object.fromEntries(Object.entries(contract).reverse());
  assert.equal(
    contractRevision(workContractSchema.parse(reordered)),
    contractRevision(contract),
  );
  const edited = {
    ...contract,
    acceptanceCriteria: ["Missing sizes sort first"],
  };
  assert.notEqual(
    gateRevision(edited, "scope"),
    gateRevision(contract, "scope"),
  );
  const design = {
    summary: "Use explicit missing-size branch",
    alternatives: [],
    stages: ["Comparator"],
    verification: "Regression tests",
    rollback: "Revert",
    references: [],
  };
  assert.equal(
    gateRevision({ ...contract, design }, "scope"),
    gateRevision(contract, "scope"),
  );
  assert.notEqual(
    contractRevision({ ...contract, design }),
    contractRevision(contract),
  );
  const standard = {
    ...contract,
    assessment: { ...contract.assessment, proposedTrack: "B" as const },
  };
  assert.equal(
    assessReadiness(
      { ...standard, acceptanceCriteria: edited.acceptanceCriteria },
      [approved("scope", standard)],
      policy,
    ).state,
    "awaiting-scope-approval",
  );
});

test("actual changes detect risk escalation and scope expansion before repair", () => {
  assert.deepEqual(
    reassessChanges(contract, "A", policy, ["src/sorting/size.ts"]),
    [],
  );
  assert.ok(
    reassessChanges(contract, "A", policy, ["src/auth/login.ts"]).some(
      (reason) => reason.code === "scope-expansion",
    ),
  );
  const rules = sdlcPolicySchema.parse({
    enabled: true,
    riskRules: [{ paths: ["db/**"], minimumTrack: "C" }],
  });
  assert.ok(
    reassessChanges(contract, "A", rules, ["db/migrations/1.sql"]).some(
      (reason) => reason.code === "track-escalation",
    ),
  );
});

test("agent contracts reject fabricated approvals and unsafe paths", () => {
  assert.equal(
    workContractSchema.safeParse({
      ...contract,
      approvals: [approved("scope")],
    }).success,
    false,
  );
  for (const path of [
    "../secrets",
    "/etc/passwd",
    "src/../secrets",
    "src\\file",
  ]) {
    assert.equal(
      workContractSchema.safeParse({ ...contract, scopePaths: [path] }).success,
      false,
    );
  }
});

test("declared scope applies protected risk floors even when assessment paths are omitted", () => {
  const rules = sdlcPolicySchema.parse({
    enabled: true,
    riskRules: [{ paths: ["db/migrations/**"], minimumTrack: "C" }],
  });
  for (const scopePaths of [["db/migrations/001.sql"], ["db/**"], ["**"]]) {
    const scoped = {
      ...contract,
      scopePaths,
      assessment: { ...contract.assessment, paths: [] },
    };
    assert.equal(resolveTrack(scoped, rules).track, "C");
    assert.equal(
      assessReadiness(scoped, [], rules).state,
      "awaiting-scope-approval",
    );
  }
  assert.equal(
    resolveTrack({ ...contract, scopePaths: ["docs/**"] }, rules).track,
    "A",
  );
  assert.equal(
    resolveTrack(
      {
        ...contract,
        scopePaths: [],
        assessment: { ...contract.assessment, paths: ["db/**"] },
      },
      rules,
    ).track,
    "C",
  );
});

test("local publication retains authoritative intent, acceptance and Work Item revision", () => {
  const project = projectSchema.parse({
    id: "project",
    checkout: "/tmp",
    hosting: {
      provider: "github",
      origin: "https://github.com",
      repository: "a/b",
      tokenEnv: "TOKEN",
    },
    agent: { provider: "codex" },
  });
  const run = createQueuedWorkRun(
    {
      id: "local-work",
      projectId: project.id,
      contract,
      revision: "a".repeat(64),
      source: { kind: "local", key: "local-task" },
      createdAt: "2026-10-21T00:00:00Z",
      updatedAt: "2026-10-21T00:00:00Z",
    },
    project,
  );
  run.readiness = { draft: true, reasons: ["Manual QA remains"] };
  const result = withDeliveryEvidence(
    {
      commitMessage: "fix: sort sizes",
      title: "Sort sizes",
      description: "Agent-authored prose",
    },
    run,
  );
  assert.match(result.description, /Work Item: local-work/);
  assert.match(
    result.description,
    /Intent: Files with missing sizes sort last/,
  );
  assert.match(result.description, /- Missing sizes sort after numeric sizes/);
  assert.ok(
    result.description.includes("Contract revision: " + "a".repeat(64)),
  );
});

test("partial project SDLC overrides preserve inherited approval and protected-path policy", () => {
  const inherited = {
    enabled: true,
    defaultTrack: "B",
    allowLocalTasks: false,
    approvalSource: "github",
    approvers: ["human"],
    riskRules: [{ paths: ["db/**"], minimumTrack: "C" }],
  };
  const configuration = configSchema.parse({
    id: "test",
    projectBase: { sdlc: inherited },
    projects: [
      {
        id: "project",
        checkout: "/tmp",
        inheritProjectBase: true,
        hosting: {
          provider: "github",
          origin: "https://github.com",
          repository: "a/b",
          tokenEnv: "TOKEN",
        },
        agent: { provider: "codex" },
        sdlc: { defaultTrack: "A" },
      },
    ],
  });
  assert.deepEqual(configuration.projects[0]!.sdlc, {
    ...inherited,
    defaultTrack: "A",
    fastTrackMaxFiles: 10,
  });
});

test("provider approval policies require an explicit approver allowlist", () => {
  for (const approvalSource of ["github", "gitlab"] as const) {
    assert.equal(
      sdlcPolicySchema.safeParse({ enabled: true, approvalSource }).success,
      false,
    );
    assert.equal(
      sdlcPolicySchema.safeParse({
        enabled: true,
        approvalSource,
        approvers: ["human"],
      }).success,
      true,
    );
  }
  assert.equal(sdlcPolicySchema.safeParse({ enabled: true }).success, true);
  assert.throws(
    () =>
      configSchema.parse({
        id: "test",
        projectBase: { sdlc: { enabled: true, approvers: ["human"] } },
        projects: [
          {
            id: "project",
            checkout: "/tmp",
            inheritProjectBase: true,
            hosting: {
              provider: "github",
              origin: "https://github.com",
              repository: "a/b",
              tokenEnv: "TOKEN",
            },
            agent: { provider: "codex" },
            sdlc: { approvalSource: "github", approvers: [] },
          },
        ],
      }),
    /approver/,
  );
});

test("Track A escalates when expected or actual changes exceed the file limit", () => {
  const limited = sdlcPolicySchema.parse({
    enabled: true,
    fastTrackMaxFiles: 2,
  });
  const files = ["src/sorting/a.ts", "src/sorting/b.ts", "src/sorting/c.ts"];
  assert.equal(resolveTrack(contract, limited, files.slice(0, 2)).track, "A");
  assert.ok(
    reassessChanges(contract, "A", limited, files).some(
      (reason) => reason.code === "track-escalation",
    ),
  );
  const broad = workContractSchema.parse({
    ...contract,
    assessment: { ...contract.assessment, paths: files },
  });
  const decision = assessReadiness(broad, [], limited);
  assert.equal(decision.track, "B");
  assert.match(decision.trackReasons.join(" "), /exceed the Track A limit/);
});
