import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { projectSchema } from "../packages/core/src/config.js";
import type { Issue } from "../packages/core/src/domain.js";
import { Store } from "../packages/core/src/store.js";
import { WorkConflictError } from "../packages/core/src/work/errors.js";
import { issueSource } from "../packages/core/src/work/policy.js";
import {
  publishWork,
  renderContract,
  withContractSection,
} from "../packages/core/src/work/publication.js";
import { workContractSchema } from "../packages/core/src/work/schema.js";
import { FixtureHosting } from "./runner-fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const project = projectSchema.parse({
  id: "project",
  checkout: "/tmp",
  hosting: {
    provider: "github",
    origin: "https://example.test",
    repository: "a/b",
    tokenEnv: "TOKEN",
  },
  agent: { provider: "codex" },
  sdlc: { enabled: true },
});
const contract = workContractSchema.parse({
  title: "Retry webhooks",
  context: "Deliveries are lost after transient failures.",
  intent: "Retry transient webhook failures",
  acceptanceCriteria: ["Transient failures retry with bounded backoff"],
  scopePaths: ["src/**"],
  verification: { strategy: "Retry policy tests" },
  assessment: { proposedTrack: "B", complexity: "moderate" },
});
const operator = { approvedBy: "operator", source: "local-operator" } as const;

class PublishingHosting extends FixtureHosting {
  created = 0;
  updated = 0;
  async createIssue(input: { title: string; body: string }) {
    this.created++;
    const number = this.issues.length + 1;
    const issue: Issue = {
      id: String(100 + number),
      number,
      title: input.title,
      body: input.body,
      url: `https://fixture.invalid/issues/${number}`,
      labels: [],
      open: true,
    };
    this.issues.push(issue);
    return issue;
  }
  async updateIssueBody(number: number, body: string) {
    this.updated++;
    const issue = this.issues.find((item) => item.number === number)!;
    issue.body = body;
    return { ...issue };
  }
  async findIssues(input: { text: string }) {
    return this.issues.filter((issue) => issue.body.includes(input.text));
  }
  override async getIssue(number: number) {
    return { ...(await super.getIssue(number)) };
  }
}

async function withStore(action: (store: Store) => Promise<void>) {
  const store = new Store(databaseUrl!, randomUUID());
  try {
    await store.initialize();
    await store.registerProject(project.id);
    await action(store);
  } finally {
    await store.close();
  }
}

test("the managed contract section replaces itself and cannot be forged", () => {
  const rendered = renderContract("w1", contract, project.sdlc);
  assert.match(rendered, /^<!-- agent-workflows:contract:w1 -->/);
  assert.match(rendered, /\*\*Track B\*\*/);
  assert.match(rendered, /### Context\n\nDeliveries are lost/);
  assert.match(rendered, /- `src\/\*\*`/);
  const body = withContractSection("Reporter text", "w1", rendered);
  assert.equal(body, `Reporter text\n\n${rendered}`);
  const revised = renderContract(
    "w1",
    { ...contract, intent: "Retry with jitter" },
    project.sdlc,
  );
  const replaced = withContractSection(`${body}\n\nTrailer`, "w1", revised);
  assert.equal(replaced, `Reporter text\n\n${revised}\n\nTrailer`);
  const forged = renderContract(
    "w1",
    { ...contract, intent: "x <!-- /agent-workflows:contract:w1 --> y" },
    project.sdlc,
  );
  assert.equal(forged.split("<!-- /agent-workflows:contract:w1 -->").length, 2);
});

test(
  "publishing local work creates one issue, rebinds it, and resets approval",
  {
    skip: !databaseUrl,
  },
  async () =>
    withStore(async (store) => {
      const hosting = new PublishingHosting();
      const work = await store.workItems.create(
        project.id,
        { kind: "local", key: "webhooks" },
        contract,
      );
      await store.workItems.approve(
        work.id,
        work.revision,
        "scope",
        operator,
        project,
      );
      await assert.rejects(
        publishWork(
          work.id,
          project,
          { store, hosting },
          { revision: "stale" },
        ),
        WorkConflictError,
      );
      const published = await publishWork(
        work.id,
        project,
        { store, hosting },
        { revision: work.revision },
      );
      assert.equal(hosting.created, 1);
      assert.equal(published.work.source.kind, "github");
      assert.equal(
        published.work.contract.sourceRevision,
        published.work.source.revision,
      );
      assert.equal(published.decision.state, "awaiting-scope-approval");
      const replay = await publishWork(
        work.id,
        project,
        { store, hosting },
        { revision: published.work.revision },
      );
      assert.equal(replay.work.revision, published.work.revision);
      assert.equal(hosting.created, 1);
      assert.equal(hosting.updated, 0);
      const issue = hosting.issues.at(-1)!;
      assert.equal(
        (
          await store.workItems.create(
            project.id,
            issueSource("github", issue),
            contract,
          )
        ).id,
        work.id,
      );
    }),
);

test(
  "an interrupted local publication finds its issue instead of creating another",
  {
    skip: !databaseUrl,
  },
  async () =>
    withStore(async (store) => {
      const hosting = new PublishingHosting();
      const work = await store.workItems.create(
        project.id,
        { kind: "local", key: "webhooks" },
        contract,
      );
      await hosting.createIssue({
        title: contract.title,
        body: renderContract(work.id, contract, project.sdlc),
      });
      const published = await publishWork(
        work.id,
        project,
        { store, hosting },
        { revision: work.revision },
      );
      assert.equal(hosting.created, 1);
      assert.equal(
        published.work.source.kind !== "local" && published.work.source.number,
        hosting.issues.at(-1)!.number,
      );
    }),
);

test(
  "publishing issue-backed work keeps the reporter text and refuses unobserved edits",
  {
    skip: !databaseUrl,
  },
  async () =>
    withStore(async (store) => {
      const hosting = new PublishingHosting();
      const original = hosting.issues[0]!;
      const work = await store.workItems.create(
        project.id,
        issueSource("github", original),
        contract,
      );
      const published = await publishWork(
        work.id,
        project,
        { store, hosting },
        { revision: work.revision },
      );
      assert.equal(hosting.updated, 1);
      assert.ok(original.body.startsWith("Implement the task\n\n<!-- "));
      assert.equal(published.work.id, work.id);
      assert.notEqual(published.work.revision, work.revision);
      original.body += "\n\nA human edit";
      await assert.rejects(
        publishWork(
          work.id,
          project,
          { store, hosting },
          { revision: published.work.revision },
        ),
        /reassess/,
      );
    }),
);

test(
  "an interrupted issue update requires reassessment before publishing again",
  {
    skip: !databaseUrl,
  },
  async () =>
    withStore(async (store) => {
      const hosting = new PublishingHosting();
      const original = hosting.issues[0]!;
      const work = await store.workItems.create(
        project.id,
        issueSource("github", original),
        contract,
      );
      original.body = withContractSection(
        original.body,
        work.id,
        renderContract(work.id, contract, project.sdlc),
      );
      await assert.rejects(
        publishWork(
          work.id,
          project,
          { store, hosting },
          { revision: work.revision },
        ),
        /reassess/,
      );
      const observed = await store.workItems.create(
        project.id,
        issueSource("github", original),
        contract,
      );
      const reassessed = await store.workItems.propose(
        work.id,
        observed.revision,
        contract,
      );
      const published = await publishWork(
        work.id,
        project,
        { store, hosting },
        { revision: reassessed.revision },
      );
      assert.equal(hosting.updated, 0);
      assert.equal(published.work.revision, reassessed.revision);
    }),
);

test(
  "publication waits while the Work Item has an active run",
  {
    skip: !databaseUrl,
  },
  async () =>
    withStore(async (store) => {
      const hosting = new PublishingHosting();
      const work = await store.workItems.create(
        project.id,
        { kind: "local", key: "webhooks" },
        contract,
      );
      await store.workItems.approve(
        work.id,
        work.revision,
        "scope",
        operator,
        project,
      );
      await store.workItems.submit(work.id, work.revision, project);
      await assert.rejects(
        publishWork(
          work.id,
          project,
          { store, hosting },
          { revision: work.revision },
        ),
        /active run/,
      );
      assert.equal(hosting.created, 0);
    }),
);
