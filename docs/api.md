# Public SDK API

Exports are in `src/index.ts`; the built package resolves to `dist/src/index.js`. Generated TypeScript declarations describe full argument/return types. Node ESM is required.

## Runner and controls

`new Runner({config,databaseUrl,hosting,agents,workspace?,workflow?,workflowVersion?,pathBaseDirectory?,promptBaseDirectory?})` injects hosting/agent adapters and optionally a workspace strategy or workflow. `hosting(project)` returns a host-qualified adapter. `agents` maps provider names to adapters. The default workspace uses the existing checkout. One DBOS runtime runs per Node process; one runner owns each configuration and checkout.

`pathBaseDirectory` must identify an existing directory. It resolves relative
state, checkout, and prompt-file paths once when the runner is constructed.
Omitting it preserves current-working-directory behavior for SDK callers.
`promptBaseDirectory` retains its narrower role and, when both are supplied,
overrides only relative prompt files.

`start()` validates registration, acquires ownership, launches DBOS, registers concurrency-one project queues, and starts polling. `poll(projectId?)` performs an immediate scan. `pause(projectId)` stops new starts while active work continues. `resume(projectId)` refuses blocked checkouts. `stop(runId)` waits for the active invocation/process to end, or cancels queued work. `retry(runId)` requires a terminal failed/blocked/cancelled run and a clean checkout, then returns a new linked run ID using its saved issue. `retry(runId, commandId, { refreshIssue: true })` fetches and validates the current hosted issue once during admission, saving it on the new run. `recover(runId)` returns a new execution ID for publication recovery of the same run. `shutdown()` stops intake, cancels and awaits active work, closes DBOS and releases ownership.

Use `try/finally` to call `shutdown()`, including failed startup. A custom `workflowVersion` must change when its durable step order changes; finish existing work before replacing an incompatible version.

Polling runs independently per project, with at most one scan in flight per project. `start()` does not wait for scans to finish; `poll(projectId?)` waits for the requested scans, joining any already in flight. Shutdown drains outstanding scans without admitting their results or starting queued work.

Retry admission serializes competing requests per project. One request creates
the next attempt; another request for the same task fails while that retry is
queued or running. Replaying the same command ID returns its existing retry,
without rechecking the checkout or emitting events. A command ID cannot identify
retries of different runs. Retry creation, project unblocking and their events
commit together; failure preserves the blocked state. The rationale for separate
run and execution identities is in
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

## Query and event interface

`runner.store` is a `Store`. Independently construct `new Store(databaseUrl, runnerId)` to inspect history after shutdown; always `close()` it. `projects()`, `runs()`, `run(id)`, `invocations(runId)` and `events(afterSequence)` return persisted data. Events are ordered by monotonic sequence, paged at 1000; advance the cursor to retrieve more. `subscribe(listener,{after,intervalMs})` polls and returns an unsubscribe function. Delivery resumes from the caller's cursor; persist it if needed.

`Store.admitRetry` owns persisted retry admission. Runner supplies its checkout
and process safety check, which runs under the project lock for new admissions
only. This callback must not mutate Store records. Operator tools should use
`retry` commands or `Runner.retry`, preserving those safety checks. The locking
boundary is recorded in [ADR 0005](adr/0005-postgresql-persistence-boundary.md).

Invocation records include project/run IDs, stable DBOS step ID and name, invocation ID, attempt, timestamps, requested/effective profile, provider, effective task prompt/source/hash, output-contract and evidence identities, artifact path and session state (`pending`, `available`, `unavailable`). Repeated custom steps retain separate invocations. A retry has a separate run record linked to its predecessor.

Writable invocation before/after evidence is retained on the run. Publication
finalization persists contributing provider identities in first-contribution
order, independent of custom stage names. Recovery reuses that provenance and
the finalized publication message.

`request(kind,target)` queues the same `pause`, `resume`, `stop`, `retry`, or `recover` commands used by the CLI/TUI; `commands()` reports pending/success/failure. A runner must be active to execute them. `finishCommand` and record-writing methods support adapters and custom workflows; operator tools should prefer commands over direct mutation.

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
