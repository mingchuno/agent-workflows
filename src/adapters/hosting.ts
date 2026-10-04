import { Gitlab } from "@gitbeaker/rest";
import { Octokit } from "@octokit/rest";
import type { Project } from "../config.js";
import {
  BlockedError,
  type ChangeRequest,
  type HostingAdapter,
  type Issue,
  type ReviewRequest,
  StaleReviewError,
} from "../domain.js";
import { sameReviewRevision } from "../review-intake.js";

const hostingRequestTimeoutMs = 30_000;
const hostingPageSize = 100;
const minimumGitLabMajorVersion = 17;
const maximumGitLabMajorVersion = 19;

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
async function verifyReviewTarget(
  hosting: HostingAdapter,
  input: Parameters<HostingAdapter["publishReview"]>[0],
): Promise<void> {
  if (!input.reviewTarget) return;
  const { request, labels } = input.reviewTarget;
  const current = await hosting.getChange(input.change.id);
  if (
    !current.open ||
    current.draft ||
    current.fork ||
    !labels.every((label) => current.labels.includes(label)) ||
    !sameReviewRevision(request, current)
  )
    throw new StaleReviewError();
}
function reviewPresentation(
  input: Parameters<HostingAdapter["publishReview"]>[0],
) {
  const { inline, summaryFindings } = input.positions;
  const body = [
    `Review of ${input.head}`,
    input.review.summary,
    ...summaryFindings,
    marker(input.runId),
  ].join("\n\n");
  return { inline, body };
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
      request: { timeout: hostingRequestTimeoutMs, redirect: "error" },
    });
  }
  async listChanges(labels: string[]): Promise<ReviewRequest[]> {
    const changes = await this.client.paginate(this.client.pulls.list, {
      ...this.repo,
      state: "open",
      per_page: hostingPageSize,
    });
    const selected = changes.filter(
      (change) =>
        !change.draft &&
        change.head.repo?.id === change.base.repo.id &&
        labels.every((label) =>
          change.labels.some((value) => value.name === label),
        ),
    );
    const requests: ReviewRequest[] = [];
    for (const change of selected)
      requests.push(await this.getChange(change.number));
    return requests;
  }
  async getChange(number: number): Promise<ReviewRequest> {
    const { data } = await this.client.pulls.get({
      ...this.repo,
      pull_number: number,
    });
    const { data: comparison } = await this.client.repos.compareCommits({
      ...this.repo,
      base: data.base.sha,
      head: data.head.sha,
    });
    return {
      id: String(data.id),
      number: data.number,
      title: data.title,
      body: data.body ?? "",
      url: data.html_url,
      labels: data.labels.map((label) => label.name ?? ""),
      open: data.state === "open",
      draft: data.draft === true,
      fork: data.head.repo?.id !== data.base.repo.id,
      sourceBranch: data.head.ref,
      targetBranch: data.base.ref,
      base: comparison.merge_base_commit.sha,
      start: data.base.sha,
      change: { id: data.number, url: data.html_url, head: data.head.sha },
    };
  }
  async listIssues(labels: string[]): Promise<Issue[]> {
    const issues = await this.client.paginate(this.client.issues.listForRepo, {
      ...this.repo,
      state: "open",
      labels: labels.join(","),
      per_page: hostingPageSize,
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
      per_page: hostingPageSize,
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
      per_page: hostingPageSize,
    });
    if (reviews.some((review) => review.body?.includes(marker(input.runId))))
      return;
    if ((await this.head(input.change)) !== input.head)
      throw new StaleReviewError();
    await verifyReviewTarget(this, input);
    const { inline, body } = reviewPresentation(input);
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
      queryTimeout: hostingRequestTimeoutMs,
    });
  }
  async preflight(): Promise<void> {
    const metadata = await this.client.Metadata.show();
    const major = Number(metadata.version.split(".")[0]);
    if (
      !Number.isInteger(major) ||
      major < minimumGitLabMajorVersion ||
      major > maximumGitLabMajorVersion
    )
      throw new Error(
        `Supported GitLab versions are ${minimumGitLabMajorVersion}.x–${maximumGitLabMajorVersion}.x; instance reports ${metadata.version}`,
      );
  }
  async listChanges(labels: string[]): Promise<ReviewRequest[]> {
    const changes = await this.client.MergeRequests.all({
      projectId: this.repository,
      state: "opened",
      labels: labels.join(","),
      perPage: hostingPageSize,
    });
    const requests: ReviewRequest[] = [];
    for (const change of changes) {
      if (
        change.draft ||
        change.work_in_progress ||
        change.source_project_id !== change.target_project_id
      )
        continue;
      requests.push(await this.getChange(change.iid));
    }
    return requests;
  }
  async getChange(number: number): Promise<ReviewRequest> {
    const change = await this.client.MergeRequests.show(
      this.repository,
      number,
    );
    const refs = change.diff_refs;
    if (!refs?.base_sha || !refs.start_sha || !refs.head_sha)
      throw new Error("GitLab diff refs unavailable");
    return {
      id: String(change.id),
      number: change.iid,
      title: change.title,
      body: change.description ?? "",
      url: change.web_url,
      labels: change.labels.map((label) =>
        typeof label === "string" ? label : label.name,
      ),
      open: change.state === "opened",
      draft: change.draft || change.work_in_progress,
      fork: change.source_project_id !== change.target_project_id,
      sourceBranch: change.source_branch,
      targetBranch: change.target_branch,
      base: refs.base_sha,
      start: refs.start_sha,
      change: { id: change.iid, url: change.web_url, head: refs.head_sha },
    };
  }
  async listIssues(labels: string[]): Promise<Issue[]> {
    const issues = await this.client.Issues.all({
      projectId: this.repository,
      state: "opened",
      labels: labels.join(","),
      perPage: hostingPageSize,
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
      perPage: hostingPageSize,
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
      { perPage: hostingPageSize },
    );
    if (notes.some((note) => note.body.includes(marker(input.runId)))) return;
    const change = await this.client.MergeRequests.show(
      this.repository,
      input.change.id,
    );
    if (change.sha !== input.head) throw new StaleReviewError();
    await verifyReviewTarget(this, input);
    const { inline, body } = reviewPresentation(input);
    for (const [index, finding] of inline.entries()) {
      const tag = marker(input.runId, `:inline:${index}`);
      if (notes.some((note) => note.body.includes(tag))) continue;
      await verifyReviewTarget(this, input);
      const refs = change.diff_refs;
      if (!refs) throw new BlockedError("GitLab diff refs unavailable");
      await this.client.MergeRequestDiscussions.create(
        this.repository,
        input.change.id,
        `${finding.body}\n\n${tag}`,
        {
          position: {
            positionType: "text",
            baseSha: input.reviewTarget?.request.base ?? refs.base_sha,
            startSha: input.reviewTarget?.request.start ?? refs.start_sha,
            headSha: input.head,
            newPath: finding.path,
            oldPath: finding.oldPath,
            newLine: String(finding.line),
          },
        },
      );
    }
    if ((await this.head(input.change)) !== input.head)
      throw new StaleReviewError();
    await verifyReviewTarget(this, input);
    await this.client.MergeRequestNotes.create(
      this.repository,
      input.change.id,
      body,
    );
  }
}
export function createHosting(project: Project): HostingAdapter {
  return project.hosting.provider === "github"
    ? new GitHubHosting(project)
    : new GitLabHosting(project);
}
