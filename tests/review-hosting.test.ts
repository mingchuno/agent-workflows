import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { GitHubHosting, GitLabHosting } from "../src/adapters/hosting.js";
import { projectSchema } from "../src/config.js";

for (const provider of ["github", "gitlab"] as const) {
  test(`${provider} discovers labelled same-repository requests and publishes pinned reviews`, async () => {
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    const notes: Array<{ body: string }> = [];
    const reviews: Array<{ body: string }> = [];
    const pages: number[] = [];
    let pageBase = "";
    const request =
      provider === "github"
        ? {
            id: 42,
            number: 7,
            title: "Review",
            body: "Requirements",
            html_url: "https://fixture/pr/7",
            state: "open",
            draft: false,
            labels: [{ name: "review" }],
            head: { sha: "head", ref: "feature", repo: { id: 1 } },
            base: { sha: "target", ref: "main", repo: { id: 1 } },
          }
        : {
            id: 42,
            iid: 7,
            title: "Review",
            description: "Requirements",
            web_url: "https://fixture/mr/7",
            state: "opened",
            draft: false,
            work_in_progress: false,
            labels: ["review"],
            source_project_id: 1,
            target_project_id: 1,
            source_branch: "feature",
            target_branch: "main",
            sha: "head",
            diff_refs: {
              base_sha: "base",
              start_sha: "target",
              head_sha: "head",
            },
          };
    const fork =
      provider === "github"
        ? { ...request, head: { sha: "fork", ref: "feature", repo: { id: 2 } } }
        : { ...request, source_project_id: 2 };
    const server = createServer(async (incoming, response) => {
      response.setHeader("content-type", "application/json");
      const url = new URL(incoming.url!, pageBase);
      const path = url.pathname;
      if (incoming.method === "POST") {
        let raw = "";
        for await (const chunk of incoming) raw += chunk;
        const contentType = incoming.headers["content-type"] ?? "";
        const body = contentType.includes("multipart/form-data")
          ? Object.fromEntries(
              await new Response(raw, {
                headers: { "content-type": contentType },
              }).formData(),
            )
          : JSON.parse(raw);
        posts.push({ path, body });
        if (path.endsWith("/reviews")) reviews.push({ body: body.body });
        else notes.push({ body: body.body });
        response.statusCode = 201;
        response.end(JSON.stringify({ id: posts.length, ...body }));
        return;
      }
      if (path.endsWith("/reviews")) {
        response.end(JSON.stringify(reviews));
        return;
      }
      if (path.endsWith("/notes")) {
        response.end(JSON.stringify(notes));
        return;
      }
      if (path.includes("/compare/")) {
        response.end(JSON.stringify({ merge_base_commit: { sha: "base" } }));
        return;
      }
      if (path.endsWith("/pulls") || path.endsWith("/merge_requests")) {
        const page = Number(url.searchParams.get("page") ?? 1);
        pages.push(page);
        if (provider === "gitlab")
          assert.equal(url.searchParams.get("labels"), "review");
        if (page === 1) {
          url.searchParams.set("page", "2");
          response.setHeader("link", `<${url}>; rel="next"`);
          response.setHeader("x-next-page", "2");
        } else response.setHeader("x-next-page", "");
        response.setHeader("x-page", String(page));
        response.setHeader("x-total-pages", "2");
        response.end(
          JSON.stringify(
            page === 1 ? [{ ...request, draft: true }, fork] : [request],
          ),
        );
        return;
      }
      response.end(JSON.stringify(request));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    pageBase = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.REVIEW_FIXTURE_TOKEN = "fixture";
    const project = projectSchema.parse({
      id: "review",
      checkout: "/tmp",
      hosting: {
        provider,
        origin: pageBase,
        repository: "a/b",
        tokenEnv: "REVIEW_FIXTURE_TOKEN",
      },
      agent: { provider: "codex" },
    });
    try {
      const hosting =
        provider === "github"
          ? new GitHubHosting(project)
          : new GitLabHosting(project);
      const selected = await hosting.listChanges(["review"]);
      assert.deepEqual(pages, [1, 2]);
      assert.equal(selected.length, 1);
      const target = selected[0]!;
      assert.equal(target.base, "base");
      assert.equal(target.start, "target");
      assert.equal(target.change.head, "head");
      const publication = {
        change: target.change,
        head: "head",
        runId: "review-run",
        review: {
          complete: true,
          limitations: [],
          summary: "Reviewed",
          findings: [
            { body: "Fix regression", path: "new.txt", line: 2 },
            { body: "General finding", path: null, line: null },
          ],
        },
        positions: {
          inline: [
            {
              body: "Fix regression",
              path: "new.txt",
              oldPath: "old.txt",
              line: 2,
            },
          ],
          summaryFindings: ["General finding"],
        },
        reviewTarget: { request: target, labels: ["review"] },
      };
      await hosting.publishReview(publication);
      await hosting.publishReview(publication);
      if (provider === "github") {
        assert.equal(posts.length, 1);
        assert.equal(posts[0]!.body.commit_id, "head");
        assert.equal(posts[0]!.body.event, "COMMENT");
        assert.deepEqual(posts[0]!.body.comments, [
          { path: "new.txt", line: 2, side: "RIGHT", body: "Fix regression" },
        ]);
        assert.match(String(posts[0]!.body.body), /General finding/);
      } else {
        assert.equal(posts.length, 2);
        const inline = posts.find((post) =>
          post.path.endsWith("/discussions"),
        )!.body;
        assert.equal(inline["position[base_sha]"], "base");
        assert.equal(inline["position[start_sha]"], "target");
        assert.equal(inline["position[head_sha]"], "head");
        assert.equal(inline["position[old_path]"], "old.txt");
        assert.equal(inline["position[new_path]"], "new.txt");
        assert.match(
          String(posts.find((post) => post.path.endsWith("/notes"))!.body.body),
          /General finding/,
        );
      }
      const stale = {
        ...publication,
        runId: "stale",
        reviewTarget: {
          ...publication.reviewTarget,
          request: { ...target, start: "previous-target" },
        },
      };
      await assert.rejects(hosting.publishReview(stale), /superseded/);
      assert.equal(posts.length, provider === "github" ? 1 : 2);
    } finally {
      server.close();
      await once(server, "close");
      delete process.env.REVIEW_FIXTURE_TOKEN;
    }
  });
}
