# Public SDK API

Exports are in `src/index.ts`; the built package resolves to `dist/src/index.js`. Generated TypeScript declarations describe full argument/return types. Node ESM is required.

## Runner and controls

`new Runner({config,databaseUrl,hosting,agents,workspace?,workflow?,workflowVersion?})` injects hosting/agent adapters and optionally a workspace strategy or workflow. `hosting(project)` returns a host-qualified adapter. `agents` maps provider names to adapters. The default workspace uses the existing checkout. One DBOS runtime runs per Node process; one runner owns each configuration and checkout.

`start()` validates registration, acquires ownership, launches DBOS, registers concurrency-one project queues, and starts polling. `poll(projectId?)` performs an immediate scan. `pause(projectId)` stops new starts while active work continues. `resume(projectId)` refuses blocked checkouts. `stop(runId)` waits for the active invocation/process to end, or cancels queued work. `retry(runId)` requires a terminal failed/blocked/cancelled run and a clean checkout, then returns a new linked run ID. `shutdown()` stops intake, cancels and awaits active work, closes DBOS and releases ownership.

Use `try/finally` to call `shutdown()`, including failed startup. A custom `workflowVersion` must change when its durable step order changes; finish existing work before replacing an incompatible version.

## Durable operations

`defaultWorkflow(operations)` composes the standard issue-to-review path. The runner calls your optional `workflow(operations)` inside an ordinary registered DBOS workflow. Use [DBOS TypeScript documentation](https://docs.dbos.dev/typescript/programming-guide) for workflow, step, queue and determinism semantics.

| Operation                                | Contract                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `eligible()`                             | Re-fetch issue; true only if open and still labelled                         |
| `prepare()`                              | Require clean Git state; fetch base and create unique branch                 |
| `implement()`                            | Fresh implementation session; reject unexpected commits or branch changes    |
| `validate()`                             | Run commands and verify unchanged diff; false means no change                |
| `writePublication()`                     | Fresh writer session; schema-check and persist generated text                |
| `commit()` / `push()`                    | Separate reconciled Git effects using the verified change set                |
| `publish()`                              | Find existing request by branch before creating a draft                      |
| `review()`                               | Fresh read-only reviewer; exact published diff, head and validation evidence |
| `publishReview()`                        | Reject stale head; reconcile review marker; map valid added-line findings    |
| `complete(outcome?)`                     | Require clean checkout and persist terminal outcome                          |
| `step(name, operation)`                  | Custom durable operation receiving current `RunRecord`                       |
| `invoke(name, stage, prompt, readOnly?)` | Custom agentic step with profile resolution and session history              |

Put side effects inside `step`; custom effects must be idempotent or reconcile their own ambiguous results. A DBOS checkpoint does not snapshot a checkout. Returning from a custom workflow without calling a terminal operation is invalid. [Reporting workflow](../examples/custom-workflow.ts) inserts a validation report without editing provider code.

## Extension contracts

`Workspace` separates `check`, `prepare`, `inspect`, `verify`, `commit`, `push` and `release`. `Snapshot` contains branch/head, changed paths, diff and a content fingerprint. Never implement release by discarding files. A future isolated workspace implementation can replace this interface without changing workflow composition.

`AgentAdapter.validate(profile)` returns observable effective settings. `invoke(input)` receives working directory, prompt/skills, read-only intent, abort signal and session/event callbacks. Call `session(id)` immediately when available. Await event persistence; invocation must not settle until its work has stopped. SDK adapters enforce process-group lifecycle; custom adapters must uphold the same contract. `processFile` is available for controlled subprocess ownership.

`HostingAdapter` provides issue pagination/revalidation, instance-qualified `identity`, change-request lookup/create, remote head, and idempotent review publication. `preflight` is optional. Reconciliation keys must be stable across response loss; providers must never infer successful publication from agent prose.

## Query and event interface

`runner.store` is a `Store`. Independently construct `new Store(databaseUrl, runnerId)` to inspect history after shutdown; always `close()` it. `projects()`, `runs()`, `run(id)`, `invocations(runId)` and `events(afterSequence)` return persisted data. Events are ordered by monotonic sequence, paged at 1000; advance the cursor to retrieve more. `subscribe(listener,{after,intervalMs})` polls and returns an unsubscribe function. Delivery resumes from the caller's cursor; persist it if needed.

Invocation records include project/run IDs, stable DBOS step ID and name, invocation ID, attempt, timestamps, requested/effective profile, provider, prompt/skill snapshots, artifact path and session state (`pending`, `available`, `unavailable`). Repeated custom steps retain separate invocations. A retry has a separate run record linked to its predecessor.

`request(kind,target)` queues the same `pause`, `resume`, `stop`, or `retry` commands used by the CLI/TUI; `commands()` reports pending/success/failure. A runner must be active to execute them. `finishCommand` and record-writing methods support adapters and custom workflows; operator tools should prefer commands over direct mutation.
