import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { configSchema } from "../packages/core/src/config.js";
import {
  assessReadiness,
  gateRevision,
} from "../packages/core/src/work/policy.js";
import {
  type ApprovalRecord,
  sdlcPolicySchema,
  workContractSchema,
} from "../packages/core/src/work/schema.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const skillNames = ["start-work"];

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? markdownFiles(resolve(directory, entry.name))
        : entry.name.endsWith(".md")
          ? [resolve(directory, entry.name)]
          : [],
    ),
  );
  return nested.flat();
}

test("skills have discoverable metadata and resolvable local references", async () => {
  for (const name of skillNames) {
    const path = resolve(root, "skills", name, "SKILL.md");
    const content = await readFile(path, "utf8");
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(content)?.[1];
    assert.ok(frontmatter, `${name} has YAML frontmatter`);
    assert.equal(/^name: (.+)$/m.exec(frontmatter)?.[1], name);
    assert.ok(
      /^description: .+$/m.test(frontmatter),
      `${name} has a discovery description`,
    );
    for (const file of await markdownFiles(dirname(path))) {
      const links = [
        ...(await readFile(file, "utf8")).matchAll(/\[[^\]]+\]\(([^)]+)\)/g),
      ].map((match) => match[1]!);
      for (const link of links) {
        if (/^(?:https?:|#)/.test(link)) continue;
        assert.ok(
          (await stat(resolve(dirname(file), link.split("#")[0]!))).isFile(),
          `${file} reference ${link} resolves`,
        );
      }
    }
  }
});

test("start-work is the only installable skill and carries setup", async () => {
  assert.deepEqual(await readdir(resolve(root, "skills")), skillNames);
  const skill = await readFile(
    resolve(root, "skills/start-work/SKILL.md"),
    "utf8",
  );
  assert.match(skill, /\(references\/setup\.md\)/);
  assert.match(skill, /doctor --json/);
});

test("the intake API example is a real standard-track contract with revision-bound approval", async () => {
  const reference = await readFile(
    resolve(root, "skills/start-work/references/work-api.md"),
    "utf8",
  );
  const example = /```json\n([\s\S]*?)\n```/.exec(reference)?.[1];
  assert.ok(example);
  const contract = workContractSchema.parse(JSON.parse(example));
  const policy = sdlcPolicySchema.parse({ enabled: true });
  assert.equal(
    assessReadiness(contract, [], policy).state,
    "awaiting-scope-approval",
  );
  const approval: ApprovalRecord = {
    id: "scope-approval",
    workItemId: "example",
    gate: "scope",
    revision: gateRevision(contract, "scope"),
    approvedBy: "operator",
    approvedAt: "2026-10-21T00:00:00.000Z",
    source: "local-operator",
  };
  assert.equal(assessReadiness(contract, [approval], policy).state, "ready");
  const revised = {
    ...contract,
    acceptanceCriteria: ["Record a failure event after each retry"],
  };
  assert.equal(
    assessReadiness(revised, [approval], policy).state,
    "awaiting-scope-approval",
  );
});

test("personal and enterprise examples resolve valid provider and policy settings", async () => {
  for (const name of ["personal", "enterprise"]) {
    const configuration = configSchema.parse(
      JSON.parse(
        await readFile(resolve(root, `examples/sdlc-${name}.json`), "utf8"),
      ),
    );
    const project = configuration.projects[0]!;
    assert.equal(project.sdlc.enabled, true);
    assert.ok(project.validation.length > 0);
    if (name === "personal") {
      assert.equal(project.agent.provider, "codex");
      assert.equal(project.hosting.provider, "github");
      assert.equal(project.sdlc.allowLocalTasks, true);
      assert.equal(project.sdlc.approvalSource, "local-operator");
    } else {
      assert.equal(project.agent.provider, "copilot");
      assert.equal(project.hosting.provider, "gitlab");
      assert.equal(project.sdlc.allowLocalTasks, false);
      assert.equal(project.sdlc.approvalSource, "gitlab");
      assert.deepEqual(project.sdlc.approvers, ["engineering-lead"]);
    }
    for (const rule of project.sdlc.riskRules) {
      if (rule.validationProfile)
        assert.ok(project.validationProfiles[rule.validationProfile]);
    }
  }
});

test("an intent-sized fast task and staged controlled task use the same policy contract", () => {
  const policy = sdlcPolicySchema.parse({ enabled: true });
  const fast = workContractSchema.parse({
    title: "Correct a typo",
    intent: "Use the current product name",
    acceptanceCriteria: ["The help text uses Agent Workflows"],
    assessment: { proposedTrack: "A", complexity: "small" },
  });
  assert.equal(assessReadiness(fast, [], policy).state, "ready");
  const controlled = workContractSchema.parse({
    title: "Add an order status column",
    intent: "Persist delivery status",
    acceptanceCriteria: ["Existing orders retain pending status"],
    scopePaths: ["db/migrations/**", "src/orders/**"],
    assessment: {
      proposedTrack: "A",
      complexity: "moderate",
      riskFlags: ["migration"],
    },
    verification: {
      strategy: "Migrate a populated disposable database and check defaults",
    },
    design: {
      summary: "Add a status column with a pending default",
      alternatives: ["Derive status at read time"],
      stages: ["Add migration and compatibility test", "Update order reads"],
      verification: "Exercise existing and new orders after migration",
      rollback: "Revert application reads before removing the column",
      references: [],
    },
  });
  assert.equal(assessReadiness(controlled, [], policy).track, "C");
  const scope: ApprovalRecord = {
    id: "scope",
    workItemId: "migration",
    gate: "scope",
    revision: gateRevision(controlled, "scope"),
    approvedBy: "operator",
    approvedAt: "2026-10-21T00:00:00.000Z",
    source: "local-operator",
  };
  assert.equal(
    assessReadiness(controlled, [scope], policy).state,
    "awaiting-design-approval",
  );
  const design: ApprovalRecord = {
    ...scope,
    id: "design",
    gate: "design",
    revision: gateRevision(controlled, "design"),
  };
  assert.equal(
    assessReadiness(controlled, [scope, design], policy).state,
    "ready",
  );
});
