import { Gitlab } from "@gitbeaker/rest";
import { Octokit } from "@octokit/rest";
import type { Project } from "../config.js";
import {
  BlockedError,
  type ChangeRequest,
  type HostingAdapter,
  type Issue,
  type Review,
} from "../domain.js";

function origin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash)
    throw new Error(
      "Hosting origin must not contain credentials, query or fragment",
    );
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(url.hostname)
    )
  )
    throw new Error("Hosting origin requires HTTPS");
  return url.href.replace(/\/$/, "");
}
function token(project: Project) {
  const value = process.env[project.hosting.tokenEnv];
  if (!value)
    throw new Error(
      `Missing credential environment variable: ${project.hosting.tokenEnv}`,
    );
  return value;
}
function marker(runId: string, suffix = "") {
  return `<!-- agent-workflows:${runId}${suffix} -->`;
}
export function inlineFindings(review: Review, diff: string) {
  const lines = new Map<string, Set<number>>();
  let path = "",
    line = 0;
  for (const text of diff.split("\n")) {
    if (text.startsWith("+++ b/")) {
      path = text.slice(6);
      lines.set(path, new Set());
    } else if (text.startsWith("@@")) {
      line = Number(/\+(\d+)/.exec(text)?.[1] ?? 0);
    } else if (text.startsWith("+")) {
      lines.get(path)?.add(line);
      line++;
    } else if (!text.startsWith("-") && !text.startsWith("\\")) line++;
  }
  return review.findings.filter(
    (finding): finding is { body: string; path: string; line: number } =>
      !!finding.path &&
      !!finding.line &&
      !!lines.get(finding.path)?.has(finding.line),
  );
}
export class GitHubHosting implements HostingAdapter {
  readonly identity: string;
  private readonly client: Octokit;
  private readonly repo: { owner: string; repo: string };
  constructor(project: Project) {
    const host = origin(project.hosting.origin);
    const [owner, repo, ...extra] = project.hosting.repository.split("/");
    if (!owner || !repo || extra.length)
      throw new Error("GitHub repository must be owner/repo");
    this.repo = { owner, repo };
    this.identity = `${host}/${owner}/${repo}`;
    this.client = new Octokit({
      auth: token(project),
      baseUrl:
        host === "https://github.com"
          ? "https://api.github.com"
          : `${host}/api/v3`,
      request: { timeout: 30000, redirect: "error" },
    });
  }
  async listIssues(labels: string[]): Promise<Issue[]> {
    const issues = await this.client.paginate(this.client.issues.listForRepo, {
      ...this.repo,
      state: "open",
      labels: labels.join(","),
      per_page: 100,
    });
    return issues
      .filter((issue) => !issue.pull_request)
      .map((issue) => ({
        id: String(issue.id),
        number: issue.number,
        title: issue.title,
        body: issue.body ?? "",
        url: issue.html_url,
        labels: issue.labels.map((label) =>
          typeof label === "string" ? label : (label.name ?? ""),
        ),
        open: issue.state === "open",
      }));
  }
  async getIssue(number: number): Promise<Issue> {
    const { data } = await this.client.issues.get({
      ...this.repo,
      issue_number: number,
    });
    return {
      id: String(data.id),
      number: data.number,
      title: data.title,
      body: data.body ?? "",
      url: data.html_url,
      labels: data.labels.map((label) =>
        typeof label === "string" ? label : (label.name ?? ""),
      ),
      open: data.state === "open" && !data.pull_request,
    };
  }
  async findChange(branch: string): Promise<ChangeRequest | undefined> {
    const changes = await this.client.paginate(this.client.pulls.list, {
      ...this.repo,
      head: `${this.repo.owner}:${branch}`,
      state: "all",
      per_page: 100,
    });
    if (changes.length > 1)
      throw new BlockedError("Multiple change requests match branch");
    const change = changes[0];
    return change
      ? { id: change.number, url: change.html_url, head: change.head.sha }
      : undefined;
  }
  async createChange(
    input: Parameters<HostingAdapter["createChange"]>[0],
  ): Promise<ChangeRequest> {
    const { data } = await this.client.pulls.create({
      ...this.repo,
      head: input.branch,
      base: input.base,
      title: input.publication.title,
      body: `${input.publication.description}\n\nRefs ${input.issue.url}\n${marker(input.runId)}`,
      draft: true,
    });
    return { id: data.number, url: data.html_url, head: data.head.sha };
  }
  async head(change: ChangeRequest): Promise<string> {
    return (
      await this.client.pulls.get({ ...this.repo, pull_number: change.id })
    ).data.head.sha;
  }
  async publishReview(
    input: Parameters<HostingAdapter["publishReview"]>[0],
  ): Promise<void> {
    const reviews = await this.client.paginate(this.client.pulls.listReviews, {
      ...this.repo,
      pull_number: input.change.id,
      per_page: 100,
    });
    if (reviews.some((review) => review.body?.includes(marker(input.runId))))
      return;
    if ((await this.head(input.change)) !== input.head)
      throw new BlockedError("Review stale: head changed");
    const inline = inlineFindings(input.review, input.diff);
    const body = [
      `Review of ${input.head}`,
      input.review.summary,
      ...input.review.findings
        .filter(
          (finding) => !inline.includes(finding as (typeof inline)[number]),
        )
        .map((finding) => finding.body),
      marker(input.runId),
    ].join("\n\n");
    await this.client.pulls.createReview({
      ...this.repo,
      pull_number: input.change.id,
      commit_id: input.head,
      event: "COMMENT",
      body,
      comments: inline.map((finding) => ({
        path: finding.path,
        line: finding.line,
        side: "RIGHT" as const,
        body: finding.body,
      })),
    });
  }
}
export class GitLabHosting implements HostingAdapter {
  readonly identity: string;
  private readonly client: InstanceType<typeof Gitlab<false>>;
  private readonly repository: string;
  constructor(project: Project) {
    const host = origin(project.hosting.origin);
    this.repository = project.hosting.repository;
    this.identity = `${host}/${this.repository}`;
    this.client = new Gitlab({
      host,
      token: token(project),
      queryTimeout: 30000,
    });
  }
  async preflight(): Promise<void> {
    const metadata = await this.client.Metadata.show();
    const major = Number(metadata.version.split(".")[0]);
    if (!Number.isInteger(major) || major < 17 || major > 19)
      throw new Error(
        `Supported GitLab versions are 17.x–19.x; instance reports ${metadata.version}`,
      );
  }
  async listIssues(labels: string[]): Promise<Issue[]> {
    const issues = await this.client.Issues.all({
      projectId: this.repository,
      state: "opened",
      labels: labels.join(","),
      perPage: 100,
    });
    return issues.map((issue) => ({
      id: String(issue.id),
      number: issue.iid,
      title: issue.title,
      body: issue.description ?? "",
      url: issue.web_url,
      labels: issue.labels,
      open: issue.state === "opened",
    }));
  }
  async getIssue(number: number): Promise<Issue> {
    const issue = await this.client.Issues.show(number, {
      projectId: this.repository,
    });
    return {
      id: String(issue.id),
      number: issue.iid,
      title: issue.title,
      body: issue.description ?? "",
      url: issue.web_url,
      labels: issue.labels.map((label) =>
        typeof label === "string" ? label : label.name,
      ),
      open: issue.state === "opened",
    };
  }
  async findChange(branch: string): Promise<ChangeRequest | undefined> {
    const changes = await this.client.MergeRequests.all({
      projectId: this.repository,
      sourceBranch: branch,
      perPage: 100,
    });
    if (changes.length > 1)
      throw new BlockedError("Multiple merge requests match branch");
    const change = changes[0];
    return change
      ? { id: change.iid, url: change.web_url, head: change.sha }
      : undefined;
  }
  async createChange(
    input: Parameters<HostingAdapter["createChange"]>[0],
  ): Promise<ChangeRequest> {
    const change = await this.client.MergeRequests.create(
      this.repository,
      input.branch,
      input.base,
      `Draft: ${input.publication.title}`,
      {
        description: `${input.publication.description}\n\nRefs ${input.issue.url}\n${marker(input.runId)}`,
        removeSourceBranch: false,
      },
    );
    return { id: change.iid, url: change.web_url, head: change.sha };
  }
  async head(change: ChangeRequest): Promise<string> {
    return (await this.client.MergeRequests.show(this.repository, change.id))
      .sha;
  }
  async publishReview(
    input: Parameters<HostingAdapter["publishReview"]>[0],
  ): Promise<void> {
    const notes = await this.client.MergeRequestNotes.all(
      this.repository,
      input.change.id,
      { perPage: 100 },
    );
    if (notes.some((note) => note.body.includes(marker(input.runId)))) return;
    const change = await this.client.MergeRequests.show(
      this.repository,
      input.change.id,
    );
    if (change.sha !== input.head)
      throw new BlockedError("Review stale: head changed");
    const inline = inlineFindings(input.review, input.diff);
    for (const [index, finding] of inline.entries()) {
      const tag = marker(input.runId, `:inline:${index}`);
      if (notes.some((note) => note.body.includes(tag))) continue;
      const refs = change.diff_refs;
      if (!refs) throw new BlockedError("GitLab diff refs unavailable");
      await this.client.MergeRequestDiscussions.create(
        this.repository,
        input.change.id,
        `${finding.body}\n\n${tag}`,
        {
          position: {
            positionType: "text",
            baseSha: refs.base_sha,
            startSha: refs.start_sha,
            headSha: input.head,
            newPath: finding.path,
            oldPath: finding.path,
            newLine: String(finding.line),
          },
        },
      );
    }
    if ((await this.head(input.change)) !== input.head)
      throw new BlockedError("Review stale: head changed");
    await this.client.MergeRequestNotes.create(
      this.repository,
      input.change.id,
      [
        `Review of ${input.head}`,
        input.review.summary,
        ...input.review.findings
          .filter(
            (finding) => !inline.includes(finding as (typeof inline)[number]),
          )
          .map((finding) => finding.body),
        marker(input.runId),
      ].join("\n\n"),
    );
  }
}
export function createHosting(project: Project): HostingAdapter {
  return project.hosting.provider === "github"
    ? new GitHubHosting(project)
    : new GitLabHosting(project);
}
