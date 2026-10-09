# `agent-workflows.json` reference

Use this file to define one runner and one or more projects. The CLI reads
`agent-workflows.json` by default; pass `--config PATH` for another file. Start
with `agent-workflows init`, then replace the generated repository, checkout,
agent, and validation values before running it. The file is strict JSON: unknown
properties are rejected.

## Minimal example

This example assumes the file is in the managed repository root. Set the database
URL and hosting token in the environment (or use [`envFile`](#cli-environment-files)).
The state directory is a sibling of the checkout, outside the repository.

```json
{
  "id": "local",
  "stateDirectory": "../application.agent-workflows",
  "projects": [
    {
      "id": "application",
      "checkout": ".",
      "hosting": {
        "provider": "github",
        "origin": "https://github.com",
        "repository": "OWNER/REPOSITORY",
        "tokenEnv": "GITHUB_TOKEN"
      },
      "agent": { "provider": "codex" },
      "validation": [{ "command": "pnpm", "args": ["test"] }]
    }
  ]
}
```

`agent` uses your authenticated local Codex or Copilot runtime. The hosting API
token does not configure Git push authentication; configure the checkout's Git
remote separately. See [provider setup](providers.md).

## Live reload

After editing the JSON or referenced prompt files, run
`agent-workflows --config PATH reload` or press `R` in the attached monitor.
Reload is explicit; files are not watched. The server rereads its original path
with the original path base and `run --project` selection. It validates the whole
candidate and resolves prompt files before replacing the active configuration.
Invalid JSON, schema errors, unreadable/blank prompts, and restart-only changes
leave the previous configuration active.

| Live changes | Restart required |
| --- | --- |
| Agent profiles, stage prompts, prompt-file contents, stage deadlines and publication session policy | Runner ID, database selector/connection, state directory |
| Validation commands/profiles, co-author settings, base branch, Git remote name and branch template | Project IDs/membership, checkout paths, hosting provider/origin/repository/token selector |
| Poll intervals, workflow enablement, labels and rereview policy | `envFile` selection, environment variables and credentials |

Active executions retain their configuration and resolved prompts. Queued runs
use current settings when their execution starts; their recorded subject and
branch remain unchanged. Workflow enablement controls intake, so disabling a
workflow does not cancel admitted runs. In-flight scans finish before reload is
acknowledged, and the next scan uses the new settings. Changed execution inputs
still prevent publication recovery and require retry.

The server does not reread dotenv contents on reload. Restart to apply environment
or credential edits. Project membership changes require restart even when the
runner started with a project subset; settings for unselected projects are not
applied to the active runner.

## Schema at a glance

A **required** field has no default. Optional fields use the defaults shown
below. IDs and names marked *identifier* accept only ASCII letters, digits,
`_`, and `-`. Every object rejects unlisted properties. Values are validated
when the file is read; checkout ownership, provider access, and path safety are
checked when the runner starts.

### Top level

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `id` | identifier | **Required** | Stable runner identity that scopes stored records and queues. |
| `projects` | nonempty `Project[]` | **Required** | Managed projects; IDs and canonical checkout roots must be unique. |
| `databaseUrlEnv` | string | `AGENT_WORKFLOWS_DATABASE_URL` | Name of the variable containing a PostgreSQL URL with a username. |
| `stateDirectory` | path string | `.agent-workflows` | Artifact directory; must be outside every managed checkout. |
| `envFile` | nonblank path string | None | CLI-only dotenv file; not part of the SDK `Configuration` type. |

### Project

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `id` | identifier | **Required** | Stable project identity. |
| `checkout` | nonempty path string | **Required** | Existing Git repository root. |
| `hosting` | `Hosting` | **Required** | Issue and PR/MR API configuration. |
| `agent` | `AgentProfile` | **Required** | Default agent for all stages. |
| `workflows` | `Workflows` | Implementation enabled, review intake disabled | Select issue implementation and existing PR/MR review intake. |
| `baseBranch` | nonempty string | `main` | Branch fetched as the work base. |
| `remote` | identifier | `origin` | Git remote name; independent of `hosting.origin`. |
| `branchTemplate` | string containing `{issue}` | `agent/{issue}-{attempt}` | Work branch name; also supports `{attempt}` and `{run}`. |
| `pollIntervalMs` | integer ≥ 100 | `30000` | Issue and PR/MR scan interval in milliseconds. |
| `validation` | `ValidationCommand[]` | `[]` | Baseline checks, in order. |
| `validationProfiles` | name → nonempty `ValidationCommand[]` | `{}` | Additional checks selected by an issue description. |
| `includeAgentCoAuthors` | boolean | `true` | Add trailers for writable agent contributions retained in the commit. |
| `stages` | `Stages` | All defaults | Optional overrides for `implementation`, `publication`, and `review`. |

### Workflows

Both workflows share one project checkout and serial queue. Configure intake under
`workflows`; configure agent instructions, profiles, and deadlines under `stages`.

| Field | Default | Meaning |
| --- | --- | --- |
| `workflows.implementation.enabled` | `true` | Discover issues and run `defaultWorkflow`. |
| `workflows.implementation.review.maxFixRounds` | `2` | Maximum repair rounds after initial validation/review; nonnegative integer, including zero. |
| `workflows.implementation.review.blockAtOrAbove` | `"P2"` | Blocking priority threshold: P0–P2 block by default; P3 does not. |
| `workflows.implementation.labels` | `["ready-for-agent"]` | Issues must have every configured label. |
| `workflows.review.enabled` | `false` | Discover existing PRs/MRs and run `reviewWorkflow`. |
| `workflows.review.labels` | `["ready-for-review"]` | Requests must have every configured label. |
| `workflows.review.rereviewOnPush` | `false` | Admit another review when the labelled request has a new head commit. |

Label arrays must be nonempty and contain nonempty strings. Review intake always
excludes drafts, closed requests, and forks. These exclusions do not change the
implementation workflow's local review before request creation.

For a review-only project, add this to the project object:

```json
"workflows": {
  "implementation": { "enabled": false },
  "review": {
    "enabled": true,
    "labels": ["ready-for-review"],
    "rereviewOnPush": false
  }
},
"stages": {
  "review": {
    "promptFile": "prompts/review.md",
    "timeoutMs": 1800000
  }
}
```

Reviews inspect the request's actual target diff and pinned source head, without
implementation, validation commands, commits, pushes, or request creation. The
checkout stays at a detached reviewed head after completion. `baseBranch` and
`branchTemplate` apply to implementation runs only. Review profiles still inherit
`agent`; implementation/publication provider compatibility is checked only when
implementation intake is enabled.

Repeated polls and restarts do not repeat the same review. With new-push reviews
disabled, a request is admitted once; removing and reapplying its labels does not
create another run. With the option enabled, each distinct head can be admitted
once. A complete implementation-workflow review of matching published content also counts toward this policy; incomplete draft summaries do not.
A head or target-diff change during inspection supersedes the review and prevents
further publication; the next new-head scan can admit a fresh review when enabled.

This alpha schema replaces project-level `labels` with
`workflows.implementation.labels`; there is no legacy alias. Persisted runs now
use `subject` instead of `issue`. Start with a fresh runner `id` for state written
by the previous schema, after stopping the old runner and resolving its work.

### Hosting

| Field | Type | Meaning |
| --- | --- | --- |
| `provider` | `"github"` or `"gitlab"` | Hosting API provider. |
| `origin` | URL string | Web origin, including a GitLab relative root if applicable. |
| `repository` | nonempty string | Provider repository path, such as `OWNER/REPOSITORY` or `group/project`. |
| `tokenEnv` | uppercase environment variable name | Variable holding the API token; pattern `[A-Z_][A-Z0-9_]*`. |

All four hosting fields are required. Do not put a token value in the JSON.

### Agent profile and stages

`agent` is a complete profile. A stage's `profile` is a partial override. If its
`provider` changes, supply any settings needed by the new provider: the old
provider's model, effort, and context settings are discarded.

| Profile field | Type | Meaning |
| --- | --- | --- |
| `provider` | `"codex"` or `"copilot"` | Required in `agent`; optional in a stage override. |
| `model` | nonempty string | Explicit provider model ID; otherwise use the runtime default. |
| `reasoningEffort` | nonempty string | Explicit provider effort, checked against its model catalog. |
| `context` | object | Copilot-only compaction settings; Codex rejects it. |
| `context.backgroundCompactionThreshold` | number > 0 and < 1 | Defaults to `0.8` when a partial Copilot context object is supplied. |
| `context.bufferExhaustionThreshold` | number > 0 and ≤ 1 | Defaults to `0.95` when a partial Copilot context object is supplied; must exceed the background threshold. |

`stages` may contain only `implementation`, `publication`, and `review`. Each
stage accepts:

| Stage field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `profile` | partial `AgentProfile` | Project `agent` | Agent settings for this stage. |
| `prompt` | nonblank string | Installed stage prompt | Literal task instructions. |
| `promptFile` | nonblank path string | Installed stage prompt | UTF-8 task instructions read at runner construction and explicit reload. |
| `timeoutMs` | positive integer | `1800000` | Entire stage deadline, including profile validation and format correction. |
| `useNewSession` | boolean, publication only | `false` | Start publication in a fresh session instead of resuming implementation. |

Set at most one of `prompt` and `promptFile`. An omitted stage uses its installed
prompt and the project agent. See [stage prompts](#stage-prompts) for override
behavior and exact defaults.

### Validation command

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `command` | nonempty string | **Required** | Executable name or path. |
| `args` | `string[]` | `[]` | Arguments passed directly, without shell expansion. |
| `timeoutMs` | positive integer | `300000` | Per-command deadline in milliseconds. |

Commands run in the canonical checkout. Command names and arguments are passed
unchanged and are not rebased to the config directory. `validationProfiles`
names use the identifier pattern above. Each profile must contain at least one command.

## Paths and startup

`--config PATH` resolves from the launch directory. Relative `stateDirectory`,
`checkout`, `promptFile`, and `envFile` values resolve from the directory
containing that config file. Pass `--config-base-directory DIRECTORY` to use a
different base; a relative option value itself resolves from the launch
directory. The base must exist. Absolute paths stay absolute. The runner resolves
and canonicalizes effective paths at startup, so later working-directory changes
cannot redirect it. SDK callers instead set `pathBaseDirectory`; see the
[Runner options](api.md#runner-options).

`init` writes relative checkout and sibling-state paths from the effective base
and refuses to overwrite an existing config file. When the file is in the
checkout root, it writes `checkout: "."` and a sibling
`<checkout-name>.agent-workflows` state path.

Issues are selected in ascending issue-number order within each intake scan.
Deduplication persists across restarts. An explicit retry creates a new numbered
attempt linked to the earlier run.

## Ticket-selected validation

Define optional checks under a project in `validationProfiles` using the same
command format as `validation`:

```json
{
  "validation": [{ "command": "pnpm", "args": ["lint"] }],
  "validationProfiles": {
    "migration": [{ "command": "pnpm", "args": ["test:migrations"] }]
  }
}
```

An issue description selects one profile with a standalone fenced block:

````markdown
```agent-workflows-validation
migration
```
````

The runner executes the project's `validation` commands first, then the selected
profile's commands. Without the block, only the baseline runs. The block must
contain exactly one configured profile name (`A-Z`, `a-z`, digits, `_`, or `-`);
duplicate, malformed, and unknown selections fail the run before checkout
preparation or agent invocation. The issue body is saved with the run, so edits
to the hosted issue do not change an existing run. A plain retry creates a new
run from its recorded issue. Use `retry RUN --refresh-issue` (or `F` in the
monitor) to snapshot the current hosted issue and its validation selection for
the new run. Later issue edits do not change that run.

## CLI environment files

Set the optional top-level `envFile` property to load one file for every CLI
command that reads the configuration:

```json
"envFile": "./runner.env"
```

Add this alongside the other top-level properties in `agent-workflows.json`.
`envFile` is a CLI-file setting, not part of the public SDK `Configuration`.
SDK callers continue to prepare their own process environment.

Example `runner.env` (replace placeholders locally):

```dotenv
AGENT_WORKFLOWS_DATABASE_URL="postgresql://USER:PASSWORD@localhost/agent_workflows"
GITHUB_TOKEN="YOUR_GITHUB_TOKEN"
APP_MODE=development # unquoted comment
APP_GREETING="hello # literal text"
APP_REFERENCE='${APP_MODE}'
```

- Existing process values win, including empty strings. Empty required database
  or hosting values still fail existing validation. Missing keys are filled from
  the file; arbitrary application variable names are supported. `databaseUrlEnv`
  and `hosting.tokenEnv` still select which names the runner uses.
- Relative paths resolve from the effective configuration base: the directory
  containing the resolved configuration file, or `--config-base-directory`
  when supplied. Absolute paths work too. Omitting `envFile` performs no `.env`
  discovery. Multiple-file layering is not supported.
- Parsing uses Node's literal dotenv syntax: quotes and comments are supported;
  `$NAME`, `${NAME}`, backticks and `$(command)` in values are not expanded or
  executed. This is not shell sourcing.
- The configuration is validated before its environment file can be discovered.
  The file is then read once before database access, hosting adapters or runner
  creation. Missing, unreadable or invalid files stop the command with a nonzero
  exit without printing file contents. Restart the runner to pick up edits.
  `init` creates a configuration without `envFile`; help and `init` do not load
  an environment file.
- The merged environment is shared across all projects in the runner. Validation,
  Git and agent worker subprocesses inherit it. Provider runtimes may apply their
  own environment policies to tools they launch; see [providers](providers.md).
  No per-project environment isolation is added.

Keep local environment files out of version control. Add their actual names to
`.gitignore` (or `.git/info/exclude`), especially inside managed checkouts where
untracked files interfere with cleanliness checks. Do not copy credentials into
configuration, prompts or issue bodies. Existing database/hosting credential
redaction remains in effect; arbitrary variable support does not classify every
application value as a secret. A GitHub API token does not configure Git push
credentials.

The setting belongs to the CLI configuration file, not the separate
`pnpm db:migrate` command. SDK callers load their own process environment before
creating a runner and continue passing `databaseUrl` explicitly. The setting's
path and contents are not part of publication-recovery fingerprints, so
credential rotation does not invalidate recovery. Node startup-only settings,
such as `NODE_EXTRA_CA_CERTS`, must be set before launching Node to affect the
CLI process.

## Profiles

A profile has `provider`, optional `model`, optional `reasoningEffort`, and optional `context`. Each stage merges its profile over project defaults. Switching provider discards the old provider's settings, so incompatible defaults cannot leak between providers. Implementation and review start fresh sessions. Publication resumes the successful implementation session after validation by default. Set `stages.publication.useNewSession: true` to start fresh; this is required when publication uses a different provider. Model, effort and context overrides apply on resume. A missing or rejected resume fails explicitly without a fresh-session fallback. Custom steps start fresh unless `resumeSessionId` is supplied.

Codex rejects `context`: its TypeScript SDK exposes no runtime context-budget/compaction controls. Explicit Codex model/effort settings are checked against the local runtime's `models_cache.json`, or a supplied `new SDKAgent("codex", {models})` catalog. A missing catalog fails clearly; omitted settings use runtime defaults and remain `unknown` in effective-profile records. The cache can be stale; refresh it using the authenticated Codex runtime when a newly available model is rejected.

Copilot queries its SDK model catalog for explicit settings. Supported context controls are `backgroundCompactionThreshold` and `bufferExhaustionThreshold`, fractions of context utilization, with defaults 0.8 and 0.95 when a partial context object is supplied. Background must be lower than exhaustion. These control compaction, not the model's hard context-window capacity. Hard capacity is recorded separately in tokens when the model catalog supplies it.

See [checked examples](../examples/config.ts). Model IDs in `modelOverrides` are placeholders that must be replaced with available models. No provider silently clamps or substitutes explicit options.

## Stage prompts

Omit `prompt` and `promptFile` to use the installed defaults. `init` leaves both
out so package upgrades update default task instructions. An override replaces
only task instructions; issue context, checkout/revision identities, permission rules
and output contracts remain application-owned.

### Default stage prompts

Implementation:

```text
Implement the supplied issue in the current checkout. Follow repository
instructions and existing conventions. Keep changes focused on the issue's
requirements, and add or update tests where needed to verify the behavior.
```

Publication:

```text
Prepare a Git commit message and a pull request or merge request title and
description for the supplied changes. Follow repository conventions. Describe
what changed and why, summarize the recorded validation accurately, and state
material limitations. Do not claim checks passed unless the supplied evidence
shows they ran and passed.
```

Review:

```text
Independently review the supplied changes against the supplied requirements
and repository conventions. Use Git commands and inspect
relevant source for correctness, regressions, and missing validation. Report
actionable findings with supporting locations where possible. State any gaps
in inspection explicitly; do not present an incomplete review as a clean review.
```

These exact defaults are checked against the runtime source.

Use either nonblank literal `prompt` text or a `promptFile` path, never both.
Files must contain nonblank UTF-8 text. Relative paths use the same configuration
base as state and checkout paths; absolute paths are allowed. Files load at
construction and explicit reload; active executions keep their resolved contents.
No templating, interpolation, or includes are supported. SDK callers use `pathBaseDirectory` as
the general base. `promptBaseDirectory`, when supplied, overrides it for prompt
files only.

```json
"stages": {
  "implementation": {},
  "publication": { "promptFile": "prompts/publication.md", "useNewSession": false },
  "review": { "prompt": "Review correctness and missing regression tests." }
}
```

Configure skills in the selected agent runtime and request them in task text.
Configuration accepts only the documented keys.

## Git identity and agent attribution

Commits use Git's native author and committer selection. The application does
not configure, validate, snapshot, or override identity. Repository, worktree,
global, system, and identity environment settings therefore behave as they do
for `git commit`, including distinct author and committer identities. Missing or
invalid identity fails at the commit operation with Git's error. The removed
`gitIdentity` property is rejected as unknown input.

Agent assistance is represented separately. With `includeAgentCoAuthors: true`,
the finalized commit message includes each provider once, ordered by its first
successful writable invocation that produced a retained change:

- `Codex <noreply@openai.com>` (OpenAI's published implementation convention)
- `Copilot <223556219+Copilot@users.noreply.github.com>` (GitHub's current
  first-party convention, not a stable product API guarantee)

Publication/review invocations and implementation invocations with no accepted
retained change are not attributed. Existing trailers are preserved,
matching agent trailers are deduplicated, and exactly one
`Agent-Workflows-Run` trailer remains. Set `includeAgentCoAuthors: false` per
project to disable injection; existing publication trailers are not removed.

Stage timeout defaults to 30 minutes, including profile validation and at most
one format-correction attempt. Correction resumes the same session with the same
provider permissions and only the remaining deadline. It must preserve the checkout;
an unavailable session prevents correction. Provider failures, cancellation, timeout and
workspace mutation never trigger correction. Custom text-only stages do not
receive format correction. Credentials belong in environment variables or
runtime authentication stores, not prompts.

## Change inspection

Use a `stateDirectory` outside every managed checkout. `init` chooses a sibling
`<checkout-name>.agent-workflows` directory for logs and process records. The runner
stores checkout fingerprints and file metadata, and creates no patch files or
change-evidence indexes.

Publication receives the checkout, base revision, changed paths, validated snapshot
identity and recorded validation. Inspect tracked changes with `git diff` and
`git diff --cached`; discover untracked files with
`git ls-files --others --exclude-standard` and inspect their content separately.
Local review receives the base and checkout snapshot, including untracked paths. Published-request review receives the exact base and head; use `git diff BASE HEAD`,
`git show` and source search. Inspect selected paths and ranges for large changes.
There is no total evidence capture limit. Agent commands remain subject to runtime
output/context limits and the stage deadline.

All three stages use implementation-level permissions: Codex `workspace-write`
with approval policy `never`; Copilot approves runtime requests except managed
human approvals. Publication, review and format correction must preserve the
source, index, branch and revision. Checkout checks reject unexpected mutation
and preserve the files for inspection; scratch output should stay outside the
checkout or in ignored paths. Permissions allow writes, so these checks detect
source mutation rather than preventing command side effects.

Review output includes `complete` and `limitations`. Incomplete standalone reviews preserve partial findings locally and block publication. Incomplete local reviews deliver a draft with an informational summary and limitations. Invocation records
retain prompts, contracts, session IDs and resume origins. Changed effective
prompts block publication recovery; file edits take effect only after reload or
restart and do not alter an active execution.

## Implementation readiness and repair

Review is mandatory in the default workflow. It runs before the final commit in
a fresh session using `stages.review.profile`. Each repair resumes implementation
and reruns configured checks and fresh review. The initial review does not consume
a repair round; the default permits two repairs and up to three reviews.

Non-draft publication requires complete review, no blocking findings, and no failed
configured checks. Exhausted repairs, failed checks, or incomplete inspection
produce a draft and complete the Run. Provider failures, cancellation, checkout
mutation, and publication errors remain operational failures. Incomplete review
ends repair and delivers a draft without consuming unused rounds.

`validation: []` skips command checks while retaining checkout integrity checks.
Nonzero exits and timeouts enter repair; command-start failures remain operational
errors. Commands run in order and stop at the first failure. Implementation and
repair report their own checks separately as agent-reported evidence. Neither
empty configured checks nor unexecuted checks are displayed as passing.

This breaking version adds structured implementation output and review priorities.
Custom agent adapters must return the documented implementation JSON contract.
Stop the old runner, resolve unfinished work, and use a fresh runner ID for older
durable state. Workflow-version checks refuse incompatible publication recovery.
