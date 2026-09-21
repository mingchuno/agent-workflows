# Agent Workflows

![Print-shop workbench with a job sheet, a worked proof, and an inspected copy awaiting human approval.](docs/assets/hero.png)

A local TypeScript SDK and CLI/TUI that turns labelled GitHub or GitLab issues into draft change requests with independent agent reviews. DBOS persists execution; each project uses its existing checkout, with one task at a time. Separate projects progress concurrently.

Supports Codex and Copilot SDKs, GitHub, and GitLab.com/self-hosted GitLab. Human review and merging remain separate.

## Why use this SDK over DBOS directly?

DBOS provides durable execution, checkpoints and queues. This SDK supplies the
coding-workflow behavior a client would otherwise build around it:

- **Ready-made operations:** issue intake, agent implementation, validation,
  draft PR/MR publication and independent review, with Codex/Copilot and
  GitHub/GitLab adapters.
- **Checkout and recovery rules:** exclusive checkout ownership, process
  cancellation, preservation of unfinished work, and reconciliation of interrupted
  commits, pushes and publication.
- **Application controls and evidence:** explicit run outcomes, safe retry
  admission, session/log records, and a shared SDK, CLI and terminal monitor.

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

For SDK use, install locally with `npm install @mingchuno/agent-workflows`. Both interfaces ship in the same package.

Edit `agent-workflows.json`: set the checkout, hosting origin/repository, agent
stages and validation commands. Relative checkout, state and prompt-file paths
resolve from the configuration file's directory. Commits use native Git identity
and disclose retained writable agent contributions with default-enabled co-author
trailers. Set the named hosting-token environment variable through your usual
secret manager; for GitHub, follow the [PAT creation and required permissions](docs/providers.md#create-a-fine-grained-personal-access-token) guide before running. Commit or ignore the configuration before running. Keep the state directory outside managed checkouts, or explicitly Git-ignore it.

```sh
agent-workflows run
# In a second terminal:
agent-workflows monitor
agent-workflows status --json
```

Alternatively, load database, hosting and application variables from one explicit
file: `agent-workflows --env-file ./runner.env run`. Existing shell values win,
including empty strings. See [environment file examples and boundaries](docs/configuration.md#cli-environment-files).

The runner fetches the configured base, creates a branch, implements an eligible issue, validates it, generates publication text, commits and pushes, creates a draft PR/MR, and publishes an independent review of its exact head. It never merges. Initial use should target a repository and issue you explicitly intend to automate; running the CLI authorizes these effects and agent usage.

## SDK

```ts
import { Runner, createAgents, createHosting } from "@mingchuno/agent-workflows";

const runner = new Runner({
  config,
  databaseUrl,
  agents: createAgents(),
  hosting: createHosting,
});
await runner.start();
// Later, stop intake and terminate in-flight local work safely:
await runner.shutdown();
```

[Custom workflow](examples/custom-workflow.ts), [complete runner](examples/run.ts), [configuration](examples/config.ts), and [inspection](examples/observe.ts) examples are type-checked with the library. The custom workflow is also exercised using controlled providers.

## Development and review

[mise](https://mise.jdx.dev/getting-started.html) pins the development Node and pnpm versions. Activate it in your shell or prefix commands with `mise exec --`.

```sh
mise trust
mise install
pnpm install --frozen-lockfile
pnpm verify
pnpm pack:smoke
```

Use `pnpm start --help` to run the CLI from source. `pnpm build` emits the runtime and declarations into `dist/src` and copies migrations to `dist/drizzle`.

`pnpm test` builds the application, then starts and removes a disposable real PostgreSQL database using `initdb`, `pg_ctl`, and `createdb` on PATH. Alternatively, set `TEST_DATABASE_URL` to a disposable database whose role can create test databases. Tests use real temporary Git repositories and controlled adapters/HTTP servers; they make no paid agent calls or writes to real hosting providers.

Schema changes and database upgrades: [database maintenance](docs/database.md). Biome formats and lints supported source/configuration files; Markdown and YAML are maintained manually.

- [Configuration and profiles](docs/configuration.md)
- [Default stage prompts](docs/configuration.md#default-stage-prompts)
- [Public SDK API and composition](docs/api.md)
- [DBOS SDK direct usage](docs/api.md#dbos-sdk-direct-usage)
- [Authentication and provider capabilities](docs/providers.md)
- [CLI, TUI, observability and recovery](docs/operations.md)
- [Observability Landscape](docs/operations.md#observability-landscape)
- [Architecture](docs/architecture.md)
- [Releases](docs/releases.md)
