# Operating the local runner

## CLI and monitor

All commands accept `--config PATH` before the subcommand.

| Command                            | Effect                                                          |
| ---------------------------------- | --------------------------------------------------------------- |
| `init`                             | Write a starter config; refuse overwrite                        |
| `run [--project ID ...]`           | Start selected projects in the foreground                       |
| `status [--json]`                  | Projects, runs and command outcomes                             |
| `inspect RUN`                      | Full run and invocation/session records as JSON                 |
| `logs RUN [--invocation ID]`       | Local agent and validation artifacts                            |
| `pause PROJECT` / `resume PROJECT` | Queue an intake control command                                 |
| `stop RUN`                         | Queue cancellation; success means active local work has stopped |
| `recover RUN`                      | Continue a failed publication step using completed checkpoints |
| `retry RUN`                        | Queue an explicit new attempt after checkout validation         |
| `monitor`                          | Attach an interactive terminal view                             |

Control commands return a command ID and `pending`; inspect `status --json` or the monitor for success/failure. With no runner, commands stay pending. Run and monitor are separate processes. Closing the monitor never cancels work. Ctrl-C on the runner stops intake, cancels active work, waits for process termination and releases ownership. Queued issues remain durable for the next start.

In the monitor, Left/Right selects a project, Up/Down a run, `[`/`]` a step/attempt event, Tab an agent invocation, `l` displays its log tail, `v` cycles validation logs, `p` pauses/resumes intake, `s` stops the selected run, `r` retries it, `c` recovers publication, and `q` closes the view. Session IDs are displayed in full for terminal selection/copying. Outcomes, validation, profiles and session state use text as well as color. Noninteractive tools use `status --json` and `inspect`.

## Observability Landscape

This section includes only options that run locally without a license key.
Cloud services and tools requiring a license key are excluded. These boundaries
apply to observability; agent and hosting providers retain their own requirements.

| Option | Available information | Integration path |
| ------ | --------------------- | ---------------- |
| Project CLI/TUI | Run outcomes, phases, invocations, sessions and local logs | Built in: `monitor`, `status --json`, `inspect RUN`, `logs RUN` |
| DBOS SDK CLI | Durable workflow status and step history | Connect directly to the runner's PostgreSQL database |
| Project `Store` API | Application records and ordered events | Build a local script or dashboard using `runs`, `run`, `invocations`, `events` and `subscribe` |
| `DBOSClient` | DBOS workflow and step records | Build a local inspector using `getWorkflow`, `listWorkflows` and `listWorkflowSteps`; close it with `destroy()` |

For DBOS CLI inspection from this repository:

```sh
pnpm exec dbos workflow list --sys-db-url "$AGENT_WORKFLOWS_DATABASE_URL"
pnpm exec dbos workflow get "<run-id>" --sys-db-url "$AGENT_WORKFLOWS_DATABASE_URL"
pnpm exec dbos workflow steps "<run-id>" --sys-db-url "$AGENT_WORKFLOWS_DATABASE_URL"
```

Use the database URL selected by `config.databaseUrlEnv` if it differs from the
default above. These commands use the installed SDK CLI and require no running
Conductor service or cloud login. See the [DBOS CLI reference](https://docs.dbos.dev/typescript/reference/cli).

The initial DBOS workflow ID equals the run ID. Publication recovery keeps the
run ID and adds a new DBOS execution ID; `inspect RUN` includes execution history
and a persisted recovery eligibility assessment. Admission performs live checks.
Inspect both layers: the
runner catches execution errors and persists application outcomes, so a DBOS
`SUCCESS` can accompany an application `failed` or `blocked` outcome. DBOS step
history does not replace the local agent/validation artifacts.

A browser dashboard is an extension path, not a bundled feature. A local server
could combine the [Store query/event API](api.md#query-and-event-interface) with
`DBOSClient.create({ systemDatabaseUrl: databaseUrl })`, joining records by run ID.
Neither inspector needs to launch another DBOS runtime. Keep database access on
the server and bind a local-only dashboard to loopback. See the
[inspection example](../examples/observe.ts) for Store lifecycle handling.

Route dashboard controls through `Store.request` or the runner's public controls.
Direct DBOS cancellation, resumption or forking bypasses application coordination
for process termination, checkout safety and retry admission.

## Ownership and recovery

Only the runner may edit or switch managed checkouts while it is active. PostgreSQL advisory locks protect runner/configuration and checkout identities. A local Git-directory lease also prevents runners using different databases from owning the same checkout. Worker/validation process-group journals prevent reuse while old work may still run.

Git process journals live in `<git-directory>/agent-workflows-processes/`, independently of the configured state directory. A surviving Git process blocks ownership acquisition after a crash. Stop requests propagate to active fetch, staging, commit and push commands; interrupted effects still require reconciliation.

Startup and phase boundaries check ownership assumptions, branch/head and actual changes. Unfinished files are never reset, cleaned, stashed or discarded automatically. Dirty files, unresolved Git operations, branch collisions, unexpected mutations and ambiguous agent recovery become inspectable blocked states. Other eligible projects continue.

Publication effects have independent DBOS checkpoints. A task commit carries `Agent-Workflows-Run`; commit recovery checks parent and marker, push recovery checks the remote ref, request creation checks the source branch, and review publication checks stable markers. Transient publication failures use bounded retries and reconciliation. Interrupted agent stages block rather than starting another writer.

## Publication recovery

For the default workflow, `recover RUN` continues a run whose latest execution
failed at `push`, `change-request`, or `review-publication`. It reuses completed
checkpoints, keeps the branch, commit and publication markers, and gives the
failed step three new attempts. Later steps execute normally. Each execution
retains its outcome, error and source execution; a repeated command ID identifies
the same recovery.

Keep the original branch and commit checked out with a clean working tree.
Recovery verifies process ownership, complete checkpoint history, local artifacts,
remote revision, workflow version, configuration and skill contents. Environment
credential rotation is allowed. Changed code or execution inputs require a fresh
retry. Recovery honors project pause and never removes an existing project block.
Checks run again inside the first step that executes, including after a crash.

Use `inspect RUN` before recovery and check command outcomes afterward. Monitor
shows execution history and the recovery restriction, if any. Eligibility based
on persisted records is provisional until the runner finishes live checks.

Agent/validation failures, cancelled or blocked runs, custom workflows, and older
runs without recovery metadata use the existing inspection and fresh-retry path.
Recovery does not restore checkouts or accept arbitrary restart steps. A newer
fresh attempt supersedes recovery of the older run.

After a blocked/failed task that cannot be recovered:

1. Read `inspect RUN`, logs, session IDs and the local Git diff.
2. Establish that no worker/process group is still running. If startup reports an old PID or process journal, inspect that exact process and stop it before recovery. Never remove a live owner's lease.
3. Preserve unfinished work on a developer-owned commit/branch or move it to a safe location. Resolve merge/rebase state yourself. Do not rely on DBOS to restore files.
4. Once the checkout is clean, request `retry RUN`. This creates a new attempt and branch from the configured base, keeping the old run and files/commits inspectable.

A failed review after publication remains a failed automation attempt, even if its draft request exists. Explicit retry starts the full workflow as a new attempt; it does not silently modify the old request. Human review/merging remains separate. A stale review never claims coverage of a changed remote head.

## Evidence and limits

Git hooks are disabled for application-authored task commits; configure required checks as validation commands. Changed symlinks and submodules require manual handling. Checkout checks detect boundary changes but do not sandbox custom adapters or prevent unrelated local tools from writing.

Validation records say exactly which command ran, when, its exit code and artifact path. No-change work skips publication. Generated commit/request text is validated and saved before Git/API writes. Logs, prompts and errors redact configured credentials and recognized secret environment values; this does not sanitize arbitrary repository content or secrets unknown to the runner.

Back up both PostgreSQL and the state directory if history/artifacts matter. The checkout and runtime session stores are separate local state. Losing them cannot be repaired from DBOS checkpoints alone. Do not change a custom workflow's step order or rename projects while its runs are pending; use a new workflow version and finish or explicitly resolve existing runs first.
