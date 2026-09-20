# Prerequisites and provider capabilities

Install Node.js 22.12+, Git and PostgreSQL 17+. Native PostgreSQL and a local PostgreSQL container are both supported. Tests were developed against PostgreSQL 17 and Node 24 on macOS; A Linux fixture CI job is supplied; remote CI has not been run for this working tree. The database must be writable by the configured role so DBOS and the application can create their schemas.

Authenticate the selected local agent runtime before starting. Codex SDK uses the bundled Codex executable and its local authentication/configuration; Copilot SDK manages a local Copilot runtime. Subscription/access policy and model availability belong to those runtimes. See [official Codex SDK documentation](https://developers.openai.com/codex/sdk/) and [Copilot SDK documentation](https://github.com/github/copilot-sdk/tree/main/docs). Routine tests never invoke paid models.

| Capability                                  | Codex                                                                | Copilot                                                           |
| ------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Implementation, writing, independent review | SDK fresh thread                                                     | SDK fresh session                                                 |
| Explicit model/effort validation            | Runtime model cache or injected catalog                              | SDK model catalog or injected catalog                             |
| Runtime context controls                    | Rejected                                                             | Compaction/exhaustion utilization fractions                       |
| Structured publication/review               | Application JSON schema validation                                   | Application JSON schema validation                                |
| Session ID                                  | `thread.started` event                                               | Session creation response                                         |
| Read-only stages                            | Read-only sandbox                                                    | Read permissions only; shell/write permission denied              |
| Cancellation                                | Owned worker process group, TERM then KILL                           | Owned worker process group, TERM then KILL                        |
| Inspection/resumption                       | Saved thread ID; SDK `resumeThread` supports local persisted threads | Saved session ID; SDK `resumeSession` supports persisted sessions |

Codex implementation uses its workspace-write sandbox. Copilot implementation approves runtime permission requests and is not an operating-system sandbox; its read-only stages deny non-read permissions. Run selected issues and skills with the permissions of the local runtime account. Checkout checks detect unexpected changes at phase boundaries.

The runner deliberately does not automatically resume interrupted agent work. Runtime session existence does not establish whether old processes are still writing. Use runtime-specific tools/SDKs to inspect sessions after stopping the runner and establishing ownership; there is no universal session-opening command.

## Environment inheritance

CLI `--env-file` values reach validation commands, Git subprocesses and agent
workers through the runner's process environment. SDK callers get the same
inheritance from their own process environment. The installed Codex SDK forwards
that environment to its executable; Copilot uses it for its local runtime, with
SDK-specific adjustments such as removing `NODE_DEBUG`.

Commands launched inside a provider remain subject to its runtime configuration.
For example, Codex's [shell environment policy](https://developers.openai.com/codex/config-advanced/#shell-environment-policy)
can filter or replace inherited values. The CLI does not override these policies
or inject environment values into an already-running remote Copilot runtime.
Controlled executable tests cover the SDK worker boundary; live model-driven
shell-tool inheritance requires the explicit smoke verification below.

## GitHub

Set `hosting.origin` to `https://github.com` or the GitHub Enterprise web origin. Repository is `owner/name`; the adapter derives the REST endpoint. `hosting.tokenEnv` names the environment variable holding the API token, for example `GITHUB_TOKEN`.

### Create a fine-grained personal access token

In GitHub **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**:

1. Set an expiration and choose the repository's user or organization as **Resource owner**.
2. Under **Repository access**, choose **Only select repositories** and select the configured `owner/name`, including for a public repository.
3. Under **Repository permissions**, grant:

   | Permission | Access | Used for |
   | ---------- | ------ | -------- |
   | Issues | Read-only | List and recheck issues for intake |
   | Pull requests | Read and write | Find/create draft PRs, check their head, and publish reviews with inline comments |
   | Metadata | Read-only (automatically included) | Required baseline repository access |

4. Generate the token and store it through your secret manager in the variable named by `hosting.tokenEnv`. If organization approval is required, wait for approval before starting the runner; pending tokens can only read public resources.

**Pull requests must be Read and write.** Reading issues or pushing a branch successfully does not establish permission to create a PR. Missing PR write access can fail the `change-request` step with `Resource not accessible by personal access token` after implementation has completed.

Git push uses the checkout's configured remote and Git credentials independently of this API token. The API adapter does not require **Contents** permission. If you also use this PAT for HTTPS Git pushes, grant **Contents: Read and write**; pushing changes to `.github/workflows/` additionally requires **Workflows: Read and write**. Do not embed credentials in remote URLs.

If access is denied, check the selected owner/repository, PR write permission, token expiration, organization approval, and the token owner's repository access. If you replace the token value, restart the runner with the updated environment; existing environment variables override `--env-file` values. An already failed run requires explicit [recovery](operations.md#ownership-and-recovery); updating permissions does not restart it.

References: GitHub's [PAT creation guide](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens), [issue permissions](https://docs.github.com/en/rest/issues/issues#list-repository-issues), [PR creation permissions](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request), and [review permissions](https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request).

Issue intake paginates and excludes PRs. Publications default to draft. Reviews use the exact commit ID and right-side added lines where valid; other findings appear in the summary.

## GitLab.com and self-hosted GitLab

Supported range: GitLab **17.x–19.x**, REST API v4. Startup checks the metadata endpoint and rejects versions outside this range. Controlled version-shaped HTTP fixtures test the shared issue/MR/review contract; no real GitLab instance has been smoke-tested in this implementation run.

```json
{
  "provider": "gitlab",
  "origin": "https://git.example.com/gitlab",
  "repository": "group/project",
  "tokenEnv": "WORK_GITLAB_TOKEN"
}
```

The relative root is preserved in API routes (`/gitlab/api/v4/...`). Provider identity includes origin, root and repository, so equal project IDs on different instances do not collide. Returned issue/MR links come from that instance. The API origin does not rewrite the Git push remote.

Use a token with API access and the project permissions needed to publish MRs and comments. Configure private CA trust with `NODE_EXTRA_CA_CERTS` before starting Node; TLS verification remains enabled. Plain HTTP is allowed only for localhost fixture servers. Never disable TLS verification globally.

Draft MRs use the supported `Draft:` title prefix. Revision-bound inline discussions use GitLab diff refs and reconcile per-finding markers; a final summary marker reconciles overall completion. See [GitLab merge requests](https://docs.gitlab.com/api/merge_requests/) and [discussions](https://docs.gitlab.com/api/discussions/) for provider semantics.

## Explicit smoke verification

Real-provider smoke tests are opt-in manual runs: configure a disposable repository/issue, authenticated agent, hosting token, Git push access and validation; run one project; inspect the draft request, exact-head review and session records. This performs paid agent usage and real remote writes. The automated acceptance evidence is fixture-based, not a claim of live-provider compatibility or account access.
