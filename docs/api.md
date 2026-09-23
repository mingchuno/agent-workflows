# Public TypeScript SDK

The package exports ESM from `@mingchuno/agent-workflows` (see
[`src/index.ts`](../src/index.ts)); its generated declarations provide the full
TypeScript types. Use Node.js 22.12 or later. The CLI and SDK share the same
runtime and configuration schema, but the CLI-only `envFile` field is not part
of `Configuration`.

Use `Runner` for issue intake and execution, `Operations` inside a custom
workflow, and `Store` for persisted inspection or queued controls. The
[configuration reference](configuration.md#schema-at-a-glance) describes every
`Configuration` field.

## Run from an application

```ts
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  configSchema,
  createAgents,
  createHosting,
  Runner,
} from "@mingchuno/agent-workflows";

const configPath = resolve("agent-workflows.json");
const config = configSchema.parse(
  JSON.parse(await readFile(configPath, "utf8")),
);
const databaseUrl = process.env[config.databaseUrlEnv];
if (!databaseUrl) throw new Error(`Set ${config.databaseUrlEnv}`);

const runner = new Runner({
  config,
  databaseUrl,
  pathBaseDirectory: dirname(configPath),
  hosting: createHosting,
  agents: createAgents(),
});
try {
  await runner.start();
  await new Promise<void>((done) => {
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
} finally {
  await runner.shutdown();
}
```

See the [type-checked complete runner](../examples/run.ts) for a custom
workflow variant. SDK callers load their own environment before constructing the
runner and pass the database URL explicitly. `configSchema.parse` applies
defaults and rejects unknown keys.

## Runner options

`new Runner(options)` requires the following:

| Option | Type | Purpose |
| --- | --- | --- |
| `config` | `Configuration` | Parsed runner and project settings. |
| `databaseUrl` | `string` | PostgreSQL connection URL. |
| `hosting` | `(project: Project) => HostingAdapter` | Create a hosting adapter for each project; `createHosting` supplies GitHub/GitLab. |
| `agents` | `Record<string, AgentAdapter>` | Provider adapters; `createAgents()` supplies Codex/Copilot. |

Optional options:

| Option | Type | Default / purpose |
| --- | --- | --- |
| `pathBaseDirectory` | `string` | Existing directory for relative state, checkout, and prompt paths; defaults to `process.cwd()`. |
| `promptBaseDirectory` | `string` | Overrides the base for relative prompt files only. |
| `workspace` | `Workspace` | Defaults to `ExistingCheckout`. |
| `workflow` | `(operations: Operations) => Promise<void>` | Defaults to `defaultWorkflow`. |
| `workflowVersion` | `string` | Durable workflow version; change it when custom step order changes. |

Paths are resolved once during construction; checkout roots are canonicalized
and ownership is checked at startup. The runner reads configured prompt files at
construction. One `Runner` owns the DBOS runtime per Node process; do not start
two runners in one process or point concurrent runners at the same checkout.

## Runner methods

| Method | Result | Behavior |
| --- | --- | --- |
| `start()` | `Promise<void>` | Validate projects, acquire checkout ownership, launch DBOS, register one-at-a-time project queues, and begin polling. |
| `poll(projectId?)` | `Promise<void>` | Scan all projects or one project immediately; joins an existing scan for that project. |
| `pause(projectId)` | `Promise<void>` | Stop new intake for that project; active work continues. |
| `resume(projectId)` | `Promise<void>` | Resume intake if the project is not blocked. |
| `stop(runId)` | `Promise<void>` | Cancel queued work or wait for the active local invocation/process to stop. |
| `retry(runId, commandId?, options?)` | `Promise<string>` | Admit a new run ID from a terminal failed, blocked, or cancelled run after safety checks. |
| `recover(runId, commandId?)` | `Promise<string>` | Admit a new execution ID for a failed publication step in the default workflow. |
| `shutdown()` | `Promise<void>` | Stop intake, cancel and await active work, close DBOS and release ownership. |

`runner.config` contains parsed, resolved configuration. `runner.store` exposes
persisted records and commands. Always call `shutdown()` in `finally`, including
when startup fails. `start()` begins polling but does not wait for an intake scan;
call `poll()` when you need to await a scan.

A plain retry keeps the issue snapshot stored with the previous run. Pass
`{ refreshIssue: true }` as the third argument to fetch and validate the current
hosted issue for the new run:

```ts
const newRunId = await runner.retry(failedRunId, undefined, {
  refreshIssue: true,
});
```

`commandId` is an optional stable identifier for an uncertain retry or recovery
request. Reusing it returns the admitted ID without creating another attempt.
Admission serializes competing requests per project and checks checkout safety.
Publication recovery keeps the run ID, branch, commit, and completed checkpoints;
see [recovery rules](operations.md#publication-recovery) and
[ADR 0003](adr/0003-run-and-execution-identity.md).

## Durable operations

`defaultWorkflow(operations)` composes the standard issue-to-review path. The runner calls your optional `workflow(operations)` inside an ordinary registered DBOS workflow. Use [DBOS TypeScript documentation](https://docs.dbos.dev/typescript/programming-guide) for workflow, step, queue and determinism semantics.

| Operation                                | Contract                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `eligible()`                             | Re-fetch issue; true only if open and still labelled                         |
| `prepare()`                              | Require clean Git state; fetch base and create unique branch                 |
| `implement()`                            | Fresh implementation session; reject unexpected commits or branch changes    |
| `validate()`                             | Run commands and verify unchanged diff; false means no change                |
| `writePublication()`                     | Validate text; finalize persisted run/co-author trailers from retained changes |
| `commit()` / `push()`                    | Separate reconciled Git effects using the verified change set                |
| `publish()`                              | Find existing request by branch before creating a draft                      |
| `review()`                               | Fresh read-only reviewer; exact published diff, head and validation evidence |
| `publishReview()`                        | Reject stale head; reconcile review marker; map valid added-line findings    |
| `complete(outcome?)`                     | Require clean checkout and persist terminal outcome                          |
| `step(name, operation)`                  | Custom durable operation receiving current `RunRecord`                       |
| `invoke(name, stage, task)` | Custom agentic step with profile resolution and session history              |

`task` separates `defaultPrompt` from an optional `context(run)` supplier.
Optional `readOnly`, Zod `outputContract`, and captured `evidence` control runtime
checks. Stage overrides replace only `defaultPrompt`. Custom stages have no
inferred built-in default; resolve file-based custom stages before invocation
with `resolveStagePrompt(stage, defaultPrompt, baseDirectory)` if they must be
frozen alongside startup configuration. The runner resolves built-in prompt files
at construction using `promptBaseDirectory ?? pathBaseDirectory ?? process.cwd()`.

```ts
await operations.invoke("report", stage, {
  defaultPrompt: "Summarize the recorded validation.",
  context: (run) => JSON.stringify(run.validation ?? []),
  readOnly: true,
});
```

An output contract enables strict response validation and one format correction
within the original deadline. Both attempts retain separate invocation/session
records under the same durable step. The returned string is validated JSON when
a contract is supplied. Codex output contracts must use its supported JSON-schema
subset: every property is required; use nullable defaults for optional locations.
Built-in review parsing accepts omitted locations and normalizes them to `null`. Interrupted calls are never automatically replayed.

Put side effects inside `step`; custom effects must be idempotent or reconcile their own ambiguous results. A DBOS checkpoint does not snapshot a checkout. Returning from a custom workflow without calling a terminal operation is invalid. [Reporting workflow](../examples/custom-workflow.ts) inserts a validation report without editing provider code.

## DBOS SDK direct usage

A custom `workflow(operations)` runs inside the runner's registered DBOS workflow.
It can mix predefined operations with direct SDK calls; no additional workflow
registration or DBOS runtime is needed. In a consuming application, declare
`@dbos-inc/dbos-sdk` as a direct dependency compatible with this package's SDK
version, and ensure both resolve to the same runtime instance.

This example adds a checkpointed health check against a local service before the
standard workflow. The service must expose `/health` on port 8080.

```ts
import { DBOS } from "@dbos-inc/dbos-sdk";
import {
  defaultWorkflow,
  type Operations,
} from "@mingchuno/agent-workflows";

export async function customWorkflow(operations: Operations): Promise<void> {
  await DBOS.runStep(
    async () => {
      const signal = AbortSignal.any([
        operations.dependencies.signal,
        AbortSignal.timeout(5_000),
      ]);
      signal.throwIfAborted();
      const response = await fetch("http://127.0.0.1:8080/health", { signal });
      await response.body?.cancel();
      if (!response.ok) {
        throw new Error(`Local service returned ${response.status}`);
      }
    },
    { name: "check-local-service", retriesAllowed: false },
  );

  await defaultWorkflow(operations);
}
```

In the [runner example](../examples/run.ts), import this function and replace its
`workflow` and `workflowVersion` options:

```ts
workflow: customWorkflow,
workflowVersion: "local-health-v1",
```

The successful check is checkpointed and skipped during recovery; it is not a
fresh health check on every restart. `defaultWorkflow` supplies the normal coding
operations and terminal outcome. See the [DBOS step API](https://docs.dbos.dev/typescript/reference/workflows-steps).

Caveats:

- `operations.step(name, callback)` adds cancellation and checkout checks, phase
  updates, step events and error redaction around `DBOS.runStep`. Prefer it for
  custom application operations. Raw steps retain DBOS history but bypass those
  additions; pass the runner's abort signal to cancellable work, as above.
- Keep I/O, time reads and randomness inside durable steps. Call orchestration
  APIs such as `DBOS.sleepms` at workflow level. Do not wrap predefined operations
  or the whole workflow inside `runStep`; each operation owns its checkpoints.
- Disabling retries does not make external writes exactly-once. A crash after an
  effect but before checkpointing can repeat it. Use stable idempotency keys or
  reconcile ambiguous results. DBOS does not snapshot or restore checkout files.
- Finish custom paths with a terminal operation such as `operations.complete()`;
  returning while a run remains queued/running is invalid.
- Change `workflowVersion` when durable step order changes, and finish or
  explicitly resolve pending runs before deploying an incompatible workflow.
- Let `Runner` own `DBOS.setConfig`, `launch` and `shutdown`. Direct SDK use inside
  a workflow does not grant another runtime or bypass checkout ownership rules.

## Extension contracts

`Workspace` separates `check`, `prepare`, `inspect`, `verify`, `commit`, `push` and `release`. `Snapshot` contains branch/head, changed paths, diff and a content fingerprint. `commit` receives the already-finalized message, including attribution and run marker, and must preserve native Git identity selection. Never implement release by discarding files. A future isolated workspace implementation can replace this interface without changing workflow composition.

`prepare`, `commit` and `push` receive an optional final `AbortSignal`. Custom workspaces must stop their subprocesses before settling a cancelled operation. The existing-checkout strategy journals Git processes under the Git directory; ownership acquisition rejects surviving process groups after a runner crash.

`AgentAdapter.validate(profile)` returns observable effective settings. `invoke(input)` receives working directory, prompt, optional application-owned `outputSchema`, read-only intent, abort signal, stage `timeoutMs` and session/event callbacks. The abort signal also covers cancellation and time spent validating the profile. Call `session(id)` immediately when available. Await event persistence; invocation must not settle until its work has stopped. SDK adapters enforce process-group lifecycle; custom adapters must uphold the same contract. `processFile` is available for controlled subprocess ownership.

`HostingAdapter` provides issue pagination/revalidation, instance-qualified `identity`, change-request lookup/create, remote head, and idempotent review publication. `preflight` is optional. Reconciliation keys must be stable across response loss; providers must never infer successful publication from agent prose.

## Store: history, events, and commands

`runner.store` is the runner's `Store`. For a separate read process or inspection
after shutdown, construct `new Store(databaseUrl, runnerId)` and close it when
finished:

```ts
import { Store } from "@mingchuno/agent-workflows";

const store = new Store(databaseUrl, config.id);
try {
  const run = await store.run(runId);
  const sessions = await store.invocations(runId);
  const events = await store.events(0, runId);
} finally {
  await store.close();
}
```

Use a runner ID matching the configuration's `id`; it scopes every query.

| Method | Result / use |
| --- | --- |
| `projects()` / `project(id)` | Persisted project state, including pause/block status. |
| `runs()` / `run(id)` | Run history or one run record. |
| `invocations(runId)` | Agent invocation and session records for a run. |
| `events(afterSequence?, runId?)` | Ordered events after a sequence, up to 1000 per call. Advance the cursor to page. |
| `subscribe(listener, { after?, intervalMs? })` | Poll for events; returns an unsubscribe function. Persist `after` if delivery must resume across restarts. |
| `request(kind, target)` | Queue a `pause`, `resume`, `stop`, `retry`, `retry-refresh`, or `recover` command; returns its command ID. |
| `commands()` | Command IDs, targets, and pending/success/failure status. |
| `recoveryPlan(runId)` | Persisted recovery eligibility and reason; live checks still happen at admission. |
| `close()` | Release the Store database connection. |

A queued command needs an active runner to execute it. `finishCommand`,
`admitRetry`, `admitRecovery`, and record-writing methods are lower-level
persistence APIs. Operator tools should use queued commands or the `Runner`
methods so checkout and process safety checks run.

Invocation records include project/run IDs, stable DBOS step ID and name,
invocation ID, attempt, timestamps, requested/effective profile, provider,
effective task prompt/source/hash, output-contract and evidence identities,
artifact path, and session state (`pending`, `available`, `unavailable`). A retry
has a separate run record linked to its predecessor. The run also retains
before/after evidence for writable invocations; publication finalization records
contributing provider identities in first-contribution order.

## Publication recovery

`Runner.recover(runId, commandId?)` supports failed publication steps in the
default workflow. It validates the source execution, checkout, configuration,
artifacts and remote state. `Store.admitRecovery` commits intent and its event
under the same project lock as retry admission; its safety callback must not
mutate Store records. Operator tools should use the runner or queued commands.

`RunRecord.executions` contains the initial execution and recovery executions,
including DBOS IDs, source execution, restart step, reused steps, configuration
fingerprint and outcomes. Run IDs remain stable for invocations and publication
markers. `Store.recoveryPlan(runId)` reports persisted eligibility and its reason;
live safety checks happen at admission and execution. Runs without execution
metadata remain readable and retryable, but cannot be recovered.

Recovery preserves the original workflow input and completed checkpoint prefix.
The accepted command ID identifies the new execution so uncertain dispatch can
be reconciled after a crash. Live checks still run in the first non-replayed
operation. See [ADR 0003](adr/0003-run-and-execution-identity.md) for the complete
identity and recovery decision.
