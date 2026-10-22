# Agent Workflows

![Print-shop workbench with a job sheet, a worked proof, and an inspected copy awaiting human approval.](docs/assets/hero.png)

A local TypeScript SDK and CLI/TUI that takes engineering work from a sentence or
an issue to a reviewed change request. One agent skill, `start-work`, is the
entry point; the CLI enforces policy, records human approval and runs the work
durably on DBOS. Human review, merging and deployment stay with you.

Supports Codex and Copilot, GitHub, and GitLab.com/self-hosted GitLab.

## Quickstart

Prerequisites: Node.js 22.12+, Git, PostgreSQL 17+, a signed-in `codex` or
`copilot`, and `gh` or `glab`. macOS and Linux are supported.

```sh
npm install -g @mingchuno/agent-workflows
npx skills add mingchuno/agent-workflows --skill start-work
```

Then, in your agent, from the repository:

```text
$start-work Fix incorrect sorting when size is null     # Codex
/start-work #123                                         # Copilot
```

`start-work` classifies the task ([adaptive SDLC](docs/engineering/sdlc.md)):

- **Track A**, a small clear change, runs inline in your agent session and opens
  the change request. No setup is needed.
- **Tracks B and C** become a Work Item that waits for your recorded approval of
  its scope (and design for C), then the worker implements, validates, reviews,
  repairs and publishes it. The first time, `start-work` offers to set up the
  repository with you: `agent-workflows init` infers the configuration from the
  repository and `agent-workflows doctor` names each remaining gap.

Day to day you need two commands:

```sh
agent-workflows run       # the worker and the web monitor; keep it running
agent-workflows monitor   # terminal monitor: runs, Work Items and approvals
```

Approve gates in the web monitor link `run` prints, or with `a` in the terminal
monitor. Everything else in `agent-workflows --help` is for the skill or for
recovery. See the [task contract](docs/engineering/task-contract.md) for schemas
and gates.

## How it works

DBOS provides durable execution, checkpoints and queues. This SDK supplies the
coding-workflow behavior a client would otherwise build around it:

- **Ready-made operations:** issue intake, agent implementation, validation,
  local review, automatic repair, and PR/MR publication, with Codex/Copilot and
  GitHub/GitLab adapters.
- **Checkout and recovery rules:** exclusive checkout ownership, process
  cancellation, preservation of unfinished work, and reconciliation of interrupted
  commits, pushes and publication.
- **Application controls and evidence:** explicit run outcomes, safe retry
  admission, session/log records, and a shared SDK, CLI, terminal and web monitor.

Each project uses its existing checkout, one task at a time; separate projects
progress concurrently. [Custom workflows can call DBOS directly](docs/api.md#dbos-sdk-direct-usage).

The runner fetches the configured base, creates a branch, implements the work,
runs the configured checks, and reviews local changes independently. It repairs
blocking findings or failed checks up to twice with fresh review after each
repair, then generates publication text, commits once and pushes. Ready results
create a non-draft PR/MR; unresolved findings, failed checks or incomplete
inspection create a draft. It never merges. Running the CLI authorizes these
effects and agent usage.

### Configuration

`agent-workflows.json` holds the checkout, hosting repository, agent, validation
commands and SDLC policy; see the [configuration reference](docs/configuration.md).
The CLI uses `gh` or `glab` sign-in for personal projects, or the variable named
by `hosting.tokenEnv` ([PAT permissions](docs/providers.md#create-a-fine-grained-personal-access-token)).
Set the database URL in `AGENT_WORKFLOWS_DATABASE_URL`, or keep it with other
secrets in an [`envFile`](docs/configuration.md#cli-environment-files) outside
the checkout.

`run` serves the web monitor on port 8787; use `--no-web` or `--web-port PORT`
to change that. See the [web monitor guide](docs/operations.md#web-monitor).

### Label intake and PR/MR review

Without SDLC, issues labelled `ready-for-agent` become runs directly. The
standalone review workflow reviews labelled PRs/MRs:

```json
"workflows": {
  "implementation": { "enabled": false },
  "review": {
    "enabled": true,
    "labels": ["ready-for-review"],
    "rereviewOnPush": false
  }
}
```

Review intake excludes drafts and forks. Set `rereviewOnPush: true` to review new
heads; both workflows share `stages.review` and the project's serial checkout
queue. See [workflow configuration](docs/configuration.md#workflows).

## SDK

Use the SDK when you need to embed the runner or compose a custom workflow.
Install `@mingchuno/agent-workflows-core` locally; it shares one version and
release with the CLI.
It accepts the same project settings as the CLI; your application supplies the
database URL and loads its own environment.

Start with the [SDK startup example](docs/api.md#run-from-an-application).
The [API reference](docs/api.md) covers runner methods, adapters, queued controls
and inspection. Type-checked examples show a [complete runner](examples/run.ts),
[custom workflow](examples/custom-workflow.ts), [configuration](examples/config.ts)
and [inspection](examples/observe.ts).

## Documentation

### Using the package

- [Configuration and profiles](docs/configuration.md)
- [Default stage prompts](docs/configuration.md#default-stage-prompts)
- [Public SDK API and composition](docs/api.md)
- [DBOS SDK direct usage](docs/api.md#dbos-sdk-direct-usage)
- [Authentication and provider capabilities](docs/providers.md)
- [CLI, TUI, observability, and recovery](docs/operations.md)
- [Observability landscape](docs/operations.md#observability-landscape)

### Maintaining the project

- [Architecture decisions](docs/adr/README.md)
- [Database maintenance](docs/database.md)
- [Release process](docs/releases.md)

## Development and review

[mise](https://mise.jdx.dev/getting-started.html) pins the development Node and pnpm versions. Activate it in your shell or prefix commands with `mise exec --`.

```sh
mise trust
mise install
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm verify
pnpm pack:smoke
```

### Preview the TUI

From this checkout, open a terminal of at least 80×24 and run:

```sh
pnpm tui:preview
# Optional scenarios:
pnpm tui:preview long-error
pnpm tui:preview stale
```

The preview renders the real monitor with mock runs and temporary logs. It needs
no database, configuration or provider credentials and makes no remote calls.
The default `mixed` scenario includes running, queued, failed, blocked and finished
runs across projects. Other scenarios are `empty`, `offline`, `stale`, `long-error`
and `pending` (commands stay unacknowledged).

Try `n` to find a run needing attention, Enter to open it, `d` for diagnostics,
`x` for action reasons, `/` to search, and `?` for help. Press `q` to exit.
For appearance checks, use `AW_TUI_THEME=light pnpm tui:preview`,
`AW_TUI_THEME=dark pnpm tui:preview` or `NO_COLOR=1 pnpm tui:preview`.

To monitor real local runs from source, use `pnpm start monitor` with your normal
configuration and database. See the [monitor guide](docs/operations.md#monitor).

### Develop the web UI

```sh
pnpm web:dev
```

Open `http://127.0.0.1:5173`. Vite reloads the UI as you edit `packages/cli/web/`.
The labelled preview uses read-only fixtures shared with the TUI demo; it needs
no database, configuration or provider credentials. Search, project selection,
outcome filters and evidence sections work. Operator commands are disabled;
fixture logs are unavailable. Stop the dev server with Ctrl-C.

```sh
pnpm web:test   # Fast fixture API checks, no database
pnpm check     # Runtime and browser TypeScript checks
pnpm lint
pnpm verify    # Full build, server, browser and workflow tests
```

Install Chromium with `pnpm exec playwright install chromium` before browser
checks. The full suite needs PostgreSQL binaries or `TEST_DATABASE_URL` as
described below.

For live local workflows, run from this checkout with your normal environment:

```sh
pnpm web:build
pnpm start --config /path/to/agent-workflows.json run
```

Open the access URL printed by the runner. This starts real workflows and
serves built assets on port 8787 using your workflow configuration;
rebuild and refresh after UI edits. The fixture dev server does not connect to
that runner.

### Checks

Use `pnpm start --help` to run the CLI from source; this builds core first.
The pnpm workspace contains `packages/core` (runtime and SDK) and `packages/cli`
(CLI, TUI, web server and browser app). `pnpm build` emits runtime and declarations
into each package's `dist/src`, migrations into `packages/core/dist/drizzle`, and
browser assets into `packages/cli/dist/web`. Root scripts coordinate both packages;
`pnpm check` also rejects mismatched package versions.

`pnpm test` builds the application, then starts and removes a disposable real PostgreSQL database using `initdb`, `pg_ctl`, and `createdb` on PATH. Alternatively, set `TEST_DATABASE_URL` to a disposable database whose role can create test databases. Tests use real temporary Git repositories and controlled adapters/HTTP servers; they make no paid agent calls or writes to real hosting providers.

Schema changes and database upgrades: [database maintenance](docs/database.md).
Biome formats and lints supported source/configuration files; Markdown and YAML
are maintained manually.
