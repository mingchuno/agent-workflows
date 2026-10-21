# Agent Workflows

![Print-shop workbench with a job sheet, a worked proof, and an inspected copy awaiting human approval.](docs/assets/hero.png)

A local TypeScript SDK and CLI/TUI that turns labelled GitHub or GitLab issues into reviewed change requests with bounded automatic repairs, and reviews existing labelled PRs/MRs. DBOS persists execution; each project uses its existing checkout, with one task at a time. Separate projects progress concurrently.

Supports Codex and Copilot SDKs, GitHub, and GitLab.com/self-hosted GitLab. Human review and merging remain separate.

Opt-in [adaptive SDLC](docs/engineering/sdlc.md) adds one `start-work` skill and
deterministic Track A/B/C policy. Track A fixes run inline in the agent session.
Track B and C work becomes a Work Item with revision-bound human approval, and the
existing worker executes it.
See the [task contract](docs/engineering/task-contract.md) for schemas and gates.

## When to use it

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

Clients configure providers and compose operations while DBOS remains responsible
for durability. [Custom workflows can call DBOS directly](docs/api.md#dbos-sdk-direct-usage).
Use this SDK when its existing-checkout, one-task-per-project model fits; use DBOS
directly when you need general-purpose workflows or want to own these policies.

## Quickstart

Prerequisites: Node.js 22.12+, Git, PostgreSQL 17+, and an authenticated Codex or Copilot runtime. macOS and Linux are supported; Windows process-group ownership is not supported.

```sh
npm install -g @mingchuno/agent-workflows
createdb agent_workflows
export AGENT_WORKFLOWS_DATABASE_URL="postgresql://$(id -un)@localhost/agent_workflows"
agent-workflows init
```

For SDK use, install `@mingchuno/agent-workflows-core` locally. The CLI and core
packages share one version and release; the CLI installs its exact matching core
dependency automatically.

Edit `agent-workflows.json`: set the checkout, hosting origin/repository, agent
stages and validation commands. Relative checkout, state and prompt-file paths
resolve from the configuration file's directory. Commits use native Git identity
and disclose retained writable agent contributions with default-enabled co-author
trailers. Set the named hosting-token environment variable through your usual
secret manager; for GitHub, follow the [PAT creation and required permissions](docs/providers.md#create-a-fine-grained-personal-access-token) guide before running. Commit or ignore the configuration before running. Keep the state directory outside managed checkouts, or explicitly Git-ignore it.

```sh
agent-workflows run
# Open the printed web monitor URL, or in a second terminal:
agent-workflows monitor
agent-workflows status --json
```

The local web monitor starts with `run` on port 8787. Use `--no-web` to disable
it or `--web-port PORT` to change its port. It ships prebuilt with the CLI and
supports the terminal monitor's inspection and operator actions. See the
[web monitor guide](docs/operations.md#web-monitor) for access and lifecycle details.

Alternatively, set `"envFile": "./runner.env"` at the top level of
`agent-workflows.json` to load database, hosting and application variables from
one explicit file. Existing process values win, including empty strings. See
[environment file examples and boundaries](docs/configuration.md#cli-environment-files).

The runner fetches the configured base, creates a branch, implements an eligible issue, runs optional configured checks, and reviews local changes independently. It repairs blocking findings or failed checks up to twice with fresh review after each repair, then generates publication text, commits once and pushes. Ready results create a non-draft PR/MR; unresolved findings, failed checks or incomplete inspection create a draft. Both deliveries complete the Run. It never merges. Initial use should target a repository and issue you explicitly intend to automate; running the CLI authorizes these effects and agent usage.

Enable the standalone review workflow per project with:

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
