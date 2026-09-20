# Architecture

DBOS owns workflow execution, durable steps and concurrency-one project queues. The runner only discovers candidates, dispatches durable identities and handles local operator commands. It does not introduce a workflow language or an interchangeable scheduler.

- `config.ts` / `domain.ts`: validated configuration, vocabulary and adapter contracts.
- `runner.ts`: local ownership, intake/deduplication, DBOS lifecycle and operator controls.
- `operations.ts`: reusable durable coding operations and the default workflow.
- `recovery.ts`: publication recovery eligibility, input fingerprints and live safety checks.
- `workspace.ts`: existing-checkout Git operations and change verification.
- `store.ts`: typed Drizzle queries for run, invocation, project, command and event records; `db/schema.ts` and `drizzle/` own the application schema and migrations.
- `adapters/`: provider clients and isolated SDK workers.
- `runtime/`: process groups, ownership journals and redacted logging.
- `cli.ts` / `tui.tsx`: shared command/query interfaces.

Application records live in `agent_workflows`; DBOS maintains its own execution schema in the same PostgreSQL database. Large streamed agent/validation logs live under the configured state directory, referenced by records. Agent calls are never automatically retried. Publication retries and explicit recovery reconcile external state first. Clean terminal state and terminal workflow outcome are deliberately separate.

Node/PostgreSQL/Git are the only runtime infrastructure; providers require their normal local authentication. Zod, Commander, Ink/React, Drizzle/node-postgres, Pino, Octokit and Gitbeaker handle standard infrastructure. Drizzle ORM and Codex SDK are Apache-2.0; the other listed runtime libraries and Copilot SDK are MIT-licensed. Exact dependency versions are pinned by the lockfile. No custom HTTP client, CLI parser or terminal renderer is introduced.

The test boundary is the public runner/workflow API using real PostgreSQL, real temporary Git repositories and controlled adapters. Separate adapter contracts exercise SDK argument/event mapping and HTTP behavior. Process-level recovery tests terminate a runner after external effects and restart it against the same state. Runtime/provider smoke calls are intentionally separate from deterministic acceptance tests.

The runner supports existing checkouts only. Higher per-project concurrency requires isolated workspaces and lifecycle design; changing the DBOS queue limit alone is unsafe.

## Package boundary

Keep one package while the SDK, CLI and TUI share a runtime, schema and release cycle. `src/adapters`, `src/runtime` and `src/db` provide internal boundaries without workspace packages. Split into a monorepo when a separately deployed app or independently versioned package needs its own dependencies and build. `pnpm-workspace.yaml` currently configures installation policy only.

## Run and execution identity

A run owns the branch, commit and publication markers. Its initial DBOS execution
uses the run ID; publication recovery forks the failed execution at its failed
step under a new execution ID, preserving completed checkpoints and the original
run input. Execution history stays in the run record. Fresh retry creates a new
run and branch.

Recovery admission and retry share a project lock. Admission persists the fork ID
before dispatch so a restarted runner can adopt an existing fork. Recovery gates
run inside the first operation that actually executes, avoiding copied pause and
safety decisions. Recovery is limited to the default workflow's publication
steps; interrupted agents still require manual inspection.
