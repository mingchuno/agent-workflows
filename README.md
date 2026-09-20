# Agent Workflows

A local TypeScript SDK and CLI/TUI that turns labelled GitHub or GitLab issues into draft change requests with independent agent reviews. DBOS persists execution; each project uses its existing checkout, with one task at a time. Separate projects progress concurrently.

Phase 1 includes Codex and Copilot SDK adapters, GitHub and GitLab.com/self-hosted GitLab adapters, durable publication reconciliation, session observability and explicit operator controls. Human review and merging remain separate.

## Quickstart

Prerequisites: Node.js 22.12+, Git, PostgreSQL 17+, and an authenticated Codex or Copilot runtime. macOS and Linux are supported; Windows process-group ownership is not supported.

```sh
npm install -g @mingchuno/agent-workflows
createdb agent_workflows
export AGENT_WORKFLOWS_DATABASE_URL="postgresql://$(id -un)@localhost/agent_workflows"
agent-workflows init
```

For SDK use, install locally with `npm install @mingchuno/agent-workflows`. Both interfaces ship in the same package.

Edit `agent-workflows.json`: set the checkout, hosting origin/repository, Git identity, agent stages and validation commands. Set the named hosting-token environment variable through your usual secret manager. Commit or ignore the configuration before running. Keep the state directory outside managed checkouts, or explicitly Git-ignore it.

```sh
agent-workflows run
# In a second terminal:
agent-workflows monitor
agent-workflows status --json
```

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
- [Public SDK API and composition](docs/api.md)
- [Authentication and provider capabilities](docs/providers.md)
- [CLI, TUI, observability and recovery](docs/operations.md)
- [Architecture and review evidence](docs/architecture.md)
- [Phase 1 acceptance](docs/acceptance.md)
- [Release setup, first publication and recovery](docs/releases.md)
- [Specification](https://github.com/mingchuno/agent-workflows/issues/1)
