# Agent Workflows

A local TypeScript SDK and CLI/TUI that turns labelled GitHub or GitLab issues into draft change requests with independent agent reviews. DBOS persists execution; each project uses its existing checkout, with one task at a time. Separate projects progress concurrently.

Phase 1 includes Codex and Copilot SDK adapters, GitHub and GitLab.com/self-hosted GitLab adapters, durable publication reconciliation, session observability and explicit operator controls. Human review and merging remain separate.

## Quickstart

Prerequisites: [mise](https://mise.jdx.dev/getting-started.html), Git, PostgreSQL 17+, and an authenticated Codex or Copilot runtime. macOS and Linux are supported; Windows process-group ownership is not supported.

```sh
mise trust
mise install
pnpm install --frozen-lockfile
pnpm build
createdb agent_workflows
export AGENT_WORKFLOWS_DATABASE_URL="postgresql://$(id -un)@localhost/agent_workflows"
node dist/src/cli.js init
```

`mise.toml` pins Node and pnpm. Activate mise in your shell or prefix commands with `mise exec --`.

Edit `agent-workflows.json`: set the checkout, hosting origin/repository, Git identity, agent stages and validation commands. Set the named hosting-token environment variable through your usual secret manager. Commit or ignore the configuration before running. Keep the state directory outside managed checkouts, or explicitly Git-ignore it.

```sh
node dist/src/cli.js run
# In a second terminal:
node dist/src/cli.js monitor
node dist/src/cli.js status --json
```

The runner fetches the configured base, creates a branch, implements an eligible issue, validates it, generates publication text, commits and pushes, creates a draft PR/MR, and publishes an independent review of its exact head. It never merges. Initial use should target a repository and issue you explicitly intend to automate; running the CLI authorizes these effects and agent usage.

## SDK

```ts
import { Runner, createAgents, createHosting } from "agent-workflows";

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

Build first when importing this checkout as a package. [Custom workflow](examples/custom-workflow.ts), [complete runner](examples/run.ts), [configuration](examples/config.ts), and [inspection](examples/observe.ts) examples are type-checked with the library. The custom workflow is also exercised using controlled providers.

## Development and review

```sh
pnpm check
pnpm test
pnpm build
pnpm lint
```

`pnpm test` builds the application, then starts and removes a disposable real PostgreSQL database using `initdb`, `pg_ctl`, and `createdb` on PATH. Alternatively, set `TEST_DATABASE_URL` to a disposable database whose role can create test databases. Tests use real temporary Git repositories and controlled adapters/HTTP servers; they make no paid agent calls or writes to real hosting providers.

Schema changes and database upgrades: [database maintenance](docs/database.md). Biome formats and lints supported source/configuration files; Markdown and YAML are maintained manually.

- [Configuration and profiles](docs/configuration.md)
- [Public SDK API and composition](docs/api.md)
- [Authentication and provider capabilities](docs/providers.md)
- [CLI, TUI, observability and recovery](docs/operations.md)
- [Architecture and review evidence](docs/architecture.md)
- [Phase 1 acceptance](docs/acceptance.md)
- [Specification](SPEC.md) · [Published issue](https://github.com/mingchuno/agent-workflows/issues/1)
