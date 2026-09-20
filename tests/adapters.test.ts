import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { SDKAgent } from "../src/adapters/agents.js";
import {
  GitHubHosting,
  GitLabHosting,
  inlineFindings,
} from "../src/adapters/hosting.js";
import { projectSchema } from "../src/config.js";

test("GitLab routes and credentials stay on a configured relative-root instance", async () => {
  const requests: Array<{ url: string; token: unknown }> = [];
  const server = createServer((request, response) => {
    requests.push({
      url: request.url!,
      token: request.headers["private-token"],
    });
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify([
        {
          id: 42,
          iid: 1,
          title: "Fixture",
          description: "Body",
          web_url: "https://private.example/gitlab/a/b/-/issues/1",
          labels: ["ready-for-agent"],
          state: "opened",
        },
      ]),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  process.env.FIXTURE_TOKEN = "fixture-credential";
  const project = projectSchema.parse({
    id: "test",
    checkout: "/tmp",
    hosting: {
      provider: "gitlab",
      origin: `http://127.0.0.1:${address.port}/gitlab`,
      repository: "a/b",
      tokenEnv: "FIXTURE_TOKEN",
    },
    agent: { provider: "copilot" },
    gitIdentity: { name: "Fixture", email: "fixture@example.com" },
  });
  try {
    const adapter = new GitLabHosting(project);
    const issues = await adapter.listIssues(["ready-for-agent"]);
    assert.equal(issues[0]?.number, 1);
    assert.match(adapter.identity, /\/gitlab\/a\/b$/);
    assert.match(
      requests[0]!.url,
      /^\/gitlab\/api\/v4\/projects\/a%2Fb\/issues\?/,
    );
    assert.equal(requests[0]!.token, "fixture-credential");
  } finally {
    server.close();
    await once(server, "close");
    delete process.env.FIXTURE_TOKEN;
  }
});
test("GitHub intake excludes pull requests", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify([
        {
          id: 1,
          number: 1,
          title: "Issue",
          body: "",
          html_url: "https://fixture/1",
          labels: [{ name: "ready-for-agent" }],
          state: "open",
        },
        { id: 2, number: 2, pull_request: {}, labels: [] },
      ]),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  process.env.FIXTURE_TOKEN = "fixture";
  const project = projectSchema.parse({
    id: "test",
    checkout: "/tmp",
    hosting: {
      provider: "github",
      origin: `http://127.0.0.1:${address.port}`,
      repository: "a/b",
      tokenEnv: "FIXTURE_TOKEN",
    },
    agent: { provider: "codex" },
    gitIdentity: { name: "Fixture", email: "fixture@example.com" },
  });
  try {
    assert.equal(
      (await new GitHubHosting(project).listIssues(["ready-for-agent"])).length,
      1,
    );
  } finally {
    server.close();
    await once(server, "close");
    delete process.env.FIXTURE_TOKEN;
  }
});
test("agent capabilities reject unsupported settings without invoking a provider", async () => {
  const adapter = new SDKAgent("codex", {
    models: [
      {
        id: "fixture",
        reasoningEfforts: ["low", "high"],
        contextWindowTokens: 100000,
      },
    ],
  });
  await assert.rejects(
    adapter.validate({
      provider: "codex",
      context: { backgroundCompactionThreshold: 0.8 },
    }),
    /does not expose/,
  );
  await assert.rejects(
    adapter.validate({
      provider: "codex",
      model: "fixture",
      reasoningEffort: "ultra",
    }),
    /Unsupported/,
  );
  assert.equal(
    (
      await adapter.validate({
        provider: "codex",
        model: "fixture",
        reasoningEffort: "high",
      })
    ).contextWindowTokens,
    100000,
  );
});
test("inline findings include only added lines in the published diff", () => {
  const review = {
    complete: true,
    limitations: [],
    summary: "Review",
    findings: [
      { body: "valid", path: "a.txt", line: 4 },
      { body: "invalid", path: "a.txt", line: 99 },
    ],
  };
  assert.equal(
    inlineFindings(review, "+++ b/a.txt\n@@ -3,0 +4,1 @@\n+new")[0]?.body,
    "valid",
  );
  assert.equal(
    inlineFindings(review, "+++ b/a.txt\n@@ -3,0 +4,1 @@\n+new").length,
    1,
  );
});

for (const major of [17, 18, 19])
  test(`GitLab ${major} API v4 fixture supports draft publication and revision-bound inline review`, async () => {
    const bodies: Array<{ path: string; body: Record<string, unknown> }> = [];
    const notes: Array<{ body: string }> = [];
    let creates = 0;
    const change = {
      iid: 8,
      web_url: "https://self.example/root/a/b/-/merge_requests/8",
      sha: "head",
      diff_refs: { base_sha: "base", start_sha: "base", head_sha: "head" },
    };
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString();
      const contentType = request.headers["content-type"] ?? "";
      const body: Record<string, unknown> = raw
        ? contentType.includes("multipart/form-data")
          ? Object.fromEntries(
              await new Response(raw, {
                headers: { "content-type": contentType },
              }).formData(),
            )
          : JSON.parse(raw)
        : {};
      const path = request.url!.split("?")[0]!;
      response.setHeader("content-type", "application/json");
      if (path.endsWith("/metadata"))
        return response.end(
          JSON.stringify({
            version: `${major}.0.0`,
            revision: "fixture",
            enterprise: false,
          }),
        );
      if (request.method === "POST") {
        bodies.push({ path, body });
        if (path.endsWith("/merge_requests")) {
          creates++;
          return response.end(JSON.stringify(change));
        }
        notes.push({ body: String(body.body) });
        return response.end(JSON.stringify({ id: 1, body: body.body }));
      }
      if (path.endsWith("/notes")) return response.end(JSON.stringify(notes));
      if (path.endsWith("/merge_requests"))
        return response.end(JSON.stringify(creates ? [change] : []));
      return response.end(JSON.stringify(change));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as { port: number };
    process.env.FIXTURE_TOKEN = "fixture";
    const project = projectSchema.parse({
      id: "test",
      checkout: "/tmp",
      hosting: {
        provider: "gitlab",
        origin: `http://127.0.0.1:${address.port}/root`,
        repository: "a/b",
        tokenEnv: "FIXTURE_TOKEN",
      },
      agent: { provider: "codex" },
      gitIdentity: { name: "Fixture", email: "fixture@example.com" },
    });
    try {
      const adapter = new GitLabHosting(project);
      await adapter.preflight();
      const published = await adapter.createChange({
        branch: "agent/1",
        base: "main",
        head: "head",
        runId: "run",
        issue: {
          id: "1",
          number: 1,
          title: "Issue",
          body: "",
          url: "https://self.example/root/a/b/-/issues/1",
          labels: [],
          open: true,
        },
        publication: {
          commitMessage: "feat: test",
          title: "Generated title",
          description: "Generated description",
        },
      });
      const review = {
        change: published,
        head: "head",
        runId: "run",
        review: {
          complete: true,
          limitations: [],
          summary: "Summary",
          findings: [{ body: "Finding", path: "a.txt", line: 4 }],
        },
        diff: "+++ b/a.txt\n@@ -3,0 +4,1 @@\n+new",
      };
      await adapter.publishReview(review);
      await adapter.publishReview(review);
      assert.equal(creates, 1);
      assert.equal(bodies[0]!.body.title, "Draft: Generated title");
      assert.equal(
        bodies.filter((body) => body.path.endsWith("/discussions")).length,
        1,
      );
      assert.equal(
        bodies.filter((body) => body.path.endsWith("/notes")).length,
        1,
      );
      assert.equal(
        bodies.find((body) => body.path.endsWith("/discussions"))!.body[
          "position[head_sha]"
        ],
        "head",
      );
    } finally {
      server.close();
      await once(server, "close");
      delete process.env.FIXTURE_TOKEN;
    }
  });

for (const provider of ["github", "gitlab"] as const)
  test(`${provider} intake follows pagination and preserves label filtering`, async () => {
    const pages: number[] = [];
    let address: { port: number };
    const server = createServer((request, response) => {
      const url = new URL(request.url!, `http://127.0.0.1:${address.port}`);
      const page = Number(url.searchParams.get("page") ?? 1);
      pages.push(page);
      assert.equal(url.searchParams.get("labels"), "ready-for-agent");
      response.setHeader("content-type", "application/json");
      if (page === 1) {
        url.searchParams.set("page", "2");
        response.setHeader("link", `<${url}>; rel="next"`);
        response.setHeader("x-next-page", "2");
      } else response.setHeader("x-next-page", "");
      response.setHeader("x-page", String(page));
      response.setHeader("x-total-pages", "2");
      const issue =
        provider === "github"
          ? {
              id: page,
              number: page,
              title: "Issue",
              body: "",
              html_url: "https://fixture/issue",
              labels: ["ready-for-agent"],
              state: "open",
            }
          : {
              id: page,
              iid: page,
              title: "Issue",
              description: "",
              web_url: "https://fixture/issue",
              labels: ["ready-for-agent"],
              state: "opened",
            };
      response.end(JSON.stringify([issue]));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    address = server.address() as { port: number };
    process.env.FIXTURE_TOKEN = "fixture";
    const project = projectSchema.parse({
      id: "test",
      checkout: "/tmp",
      hosting: {
        provider,
        origin: `http://127.0.0.1:${address.port}`,
        repository: "a/b",
        tokenEnv: "FIXTURE_TOKEN",
      },
      agent: { provider: "codex" },
      gitIdentity: { name: "Fixture", email: "fixture@example.com" },
    });
    try {
      const adapter =
        provider === "github"
          ? new GitHubHosting(project)
          : new GitLabHosting(project);
      assert.equal((await adapter.listIssues(["ready-for-agent"])).length, 2);
      assert.deepEqual(pages, [1, 2]);
    } finally {
      server.close();
      await once(server, "close");
      delete process.env.FIXTURE_TOKEN;
    }
  });
