# Operating the local runner

## CLI and monitor

All commands accept `--config PATH` before the subcommand.

| Command                            | Effect                                                          |
| ---------------------------------- | --------------------------------------------------------------- |
| `init`                             | Write a starter config; refuse overwrite                        |
| `run [--project ID ...]`           | Start selected projects in the foreground                       |
| `reload [--timeout-ms MS]`         | Reload the active server's configuration and prompt files; wait for acknowledgement |
| `status [--json]`                  | Projects, runs and command outcomes                             |
| `inspect RUN`                      | Full run and invocation/session records as JSON                 |
| `logs RUN [--invocation ID]`       | Local stage, agent and validation artifacts                     |
| `pause PROJECT` / `resume PROJECT` | Queue an intake control command                                 |
| `stop RUN`                         | Queue cancellation; success means active local work has stopped |
| `recover RUN`                      | Continue a failed publication step using completed checkpoints |
| `retry RUN`                        | Queue an explicit new attempt after checkout validation         |
| `retry RUN --refresh-issue`        | Queue a new attempt using the current hosted issue              |
| `monitor [--notify]`               | Attach an interactive terminal view; optionally alert on outcomes |

Control commands return a command ID and `pending`; inspect `status --json` or the monitor for success/failure. With no runner, commands stay pending. Run and monitor are separate processes. Closing the monitor never cancels work. Ctrl-C on the runner stops intake, cancels active work, waits for process termination and releases ownership. Queued tasks remain durable for the next start.

`reload` additionally waits for the server result, exiting successfully only when
the server acknowledges success. Its default wait is 10 seconds; `--timeout-ms`
changes that limit. A timeout leaves the command pending and does not cancel it.
The TUI keeps showing pending until acknowledgement. See the
[live-reload boundary](configuration.md#live-reload) for supported changes.

The CLI runner publishes an owner-only control record in the local OS temporary
directory, keyed by the absolute configuration path. It contains the original
runner ID, environment selector/path, database URL digest and process identity;
it stores no credentials. `reload` uses it so invalid JSON or an edited runner
ID cannot redirect the command. Use the same absolute configuration path and
startup database environment. Without an active local record, `reload` fails
without submitting a command. Normal shutdown removes the record; a later start
replaces a record whose process has exited. SDK runners use the Store command
channel directly.

The monitor uses a full-screen view and restores the terminal when closed.
It refreshes persisted workflow state and open logs every 400 ms. Database
connectivity is shown separately from command acknowledgements; it does not
prove that a runner is alive. Requires an interactive terminal of at least
80 columns by 24 rows. Wide terminals show run list, summary and sessions;
compact terminals show the focused pane. Titles and identifiers are available
in full in scrollable details. `NO_COLOR=1` disables semantic colors.

`monitor --notify` emits one desktop notification when an Execution first
reaches `completed`, `failed`, `blocked`, `cancelled`, `no-change` or
`ineligible` during that monitor session. The initial snapshot is silent;
later terminal Executions are detected across every visible project, including
Executions first seen after a database reconnection. Delivery uses OSC 9 and is
best-effort: notifications are not persisted, retried or acknowledged, and a
terminal write failure does not affect monitoring or workflow state. Current
iTerm2, Kitty, WezTerm and Ghostty releases are supported; other OSC 9
implementations may work, while Windows Terminal is not supported in this
version. Terminal permissions and settings determine whether an alert appears,
including whether foreground alerts are suppressed.

The notification payload is display-only and contains only
`agent-workflows: <project> · <issue reference> · <outcome>`. It excludes issue
titles, diagnostics, paths and internal Run, Execution and session identifiers.
Under tmux, the monitor emits one layer of DCS passthrough wrapping. tmux 3.3
and later requires `set -g allow-passthrough on`; the CLI does not change tmux
configuration.

Run details is one responsive, vertically scrollable document. It leads with
the issue, outcome, phase, attempt, total elapsed time and branch, and adds an
attention summary only when operator action may be required. At 140 columns
and above, execution history appears beside validation and agent-session
evidence; narrower terminals stack those sections in the same reading order.
The primary design target is 160×48, with 80×24 retained as the functional
fallback. An overflowing document shows its visible line range in the heading.

| Context | Keys |
| --- | --- |
| Dashboard | Left/Right project; Tab/Shift+Tab pane; Up/Down selection or scroll |
| Details | Enter opens; Up/Down or PgUp/PgDn scroll; Esc returns; `l` opens the latest current-execution session, or the stage diagnostic before a session exists |
| Progress | `[`/`]` inspect step history; End follows latest event |
| Sessions | `a` focuses session list; Up/Down selects invocation; `l` opens log |
| Validation | `v` opens validation logs |
| Controls | `p` pauses/resumes intake; `s` stops; `r` retries; `F` retries with refreshed issue; `c` recovers publication; `R` reloads configuration |
| Monitor | `?` opens the shortcut dialog; `q` or Ctrl-C closes only the monitor |
| Shortcut dialog | Tab/Shift+Tab or Left/Right changes category; Up/Down scrolls; Esc closes |
| Logs | Up/Down or `j`/`k` scroll; PgUp/PgDn page; Left/Right pan long lines |
| Logs | Home/End or `g`/`G` first/last page; `f` resumes live follow |
| Logs | Tab selects next log; `R` toggles readable/raw presentation |
| Search | `/` opens; Enter applies; `n`/`N` next/previous matching record |
| Back | Esc dismisses search/help first, then returns from logs |

Stop, retry and publication recovery require confirmation of the selected issue;
The centered dialog defaults to Cancel. Tab/Shift+Tab or Left/Right switches
between Cancel and Confirm; Enter activates the highlighted option and Esc
cancels. Unavailable actions are omitted from the footer.
A pending command stays pending until the runner acknowledges it, including
while switching projects. Logs and search cannot send workflow commands.

Search is literal and covers the entire selected file, not only the visible page.
Lowercase queries ignore case; any uppercase character makes the query
case-sensitive. Search wraps at file boundaries. Scrolling or searching pauses
follow so arriving output does not move the view. Known agent events render as
readable messages/tool activity; unknown events remain visible as JSON. Raw
presentation preserves the stored text except unsafe terminal control codes.

Execution duration includes eligibility, preparation and waits within one
execution. It excludes queue waiting and gaps before publication recovery.
Details show each execution, its queue wait and the run's total elapsed time.
Completed execution durations freeze at their first terminal outcome. Records
without timing evidence use factual labels such as `not started`, `not recorded`
or `unavailable`. Noninteractive tools use `status --json` and `inspect`. Run
details keeps complete errors under Diagnostics and exact identifiers, paths,
profiles and ISO timestamps under Technical details.

## Observability landscape

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
Inspect both layers: the runner catches execution errors and persists application
outcomes, so DBOS `SUCCESS` can accompany an application `failed` or `blocked`
outcome. DBOS step history does not replace local agent or validation artifacts.
See [ADR 0003](adr/0003-run-and-execution-identity.md) for the identity model.

## Ownership and recovery

Only the runner may edit or switch managed checkouts while it is active.
PostgreSQL advisory locks, a local Git-directory lease, and worker/validation
process journals prevent concurrent ownership and reuse while old work may still
run. See [ADR 0002](adr/0002-existing-checkouts-and-exclusive-ownership.md) for
the checkout and concurrency tradeoff.

Git process journals live in `<git-directory>/agent-workflows-processes/`, independently of the configured state directory. A surviving Git process blocks ownership acquisition after a crash. Stop requests propagate to active fetch, staging, commit and push commands; interrupted effects still require reconciliation.

Startup and phase boundaries check ownership assumptions, branch/head and actual changes. Unfinished files are never reset, cleaned, stashed or discarded automatically. Dirty files, unresolved Git operations, branch collisions, unexpected mutations and ambiguous agent recovery become inspectable blocked states. Other eligible projects continue.

Publication effects have independent DBOS checkpoints. A task commit carries
exactly one `Agent-Workflows-Run` marker and, by default, co-author trailers for
providers with retained writable contributions. Commit, push, request creation,
and review publication reconcile their durable identities before retrying an
ambiguous effect. Interrupted agent stages block rather than starting another
writer. See [ADR 0003](adr/0003-run-and-execution-identity.md) for the recovery
boundary.

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
4. Once the checkout is clean, request `retry RUN`. This creates a new attempt and branch from the configured base, keeping the old run and files/commits inspectable. Use `retry RUN --refresh-issue` to capture the current hosted issue description and validation selection in the new run. The hosted issue must retain its identity, be open, and have the required labels; its selected validation profile must be configured.

In the implementation workflow, review occurs before publication. An operational failure during review fails the attempt; unresolved findings or incomplete inspection deliver a completed draft instead. Review-summary publication failure remains a recoverable failed attempt even when the request already exists. Explicit retry starts the full workflow as a new attempt; it does not silently modify the old request. Human review/merging remains separate. A stale review never claims coverage of a changed remote head.

## Existing PR/MR reviews

Enable `workflows.review` as shown in the [configuration reference](configuration.md#workflows).
Intake excludes drafts and forks. Reviews do not run configured validation commands;
agent inspection and structured findings are retained independently of implementation.
Requests are revalidated before inspection and each publication effect. Revision or
eligibility changes after inspection produce `superseded`, without blocking an
otherwise clean project. With `rereviewOnPush: true`, a new head can receive a new
review; otherwise polls do not admit another review of that request.

For a failed review-publication step, use `retry RUN`. The retry prepares the
recorded revisions and reuses complete findings and the original review marker,
so partial inline publication and lost responses can be reconciled. `recover`
and `--refresh-issue` do not apply to review runs. Incomplete reviews preserve
partial findings locally and require fresh inspection. Checkout mutations still
block the project and preserve files for operator intervention.

The checkout remains detached at the reviewed commit. Stop the runner before
switching it manually; subsequent implementation preparation can create its normal
work branch from this clean checkout.

## Evidence and limits

Git hooks are disabled for application-authored task commits; configure required checks as validation commands. Changed symlinks and submodules require manual handling. Checkout checks detect boundary changes but do not sandbox custom adapters or prevent unrelated local tools from writing.

Git chooses author and committer through its normal configuration and environment
rules. Runner startup performs no identity preflight; missing identity fails at
the commit step before push or hosting publication.

Validation records say exactly which command ran, when, its exit code and artifact path. No-change work skips publication. Generated commit/request text is validated and saved before Git/API writes. Logs, prompts and errors redact configured credentials and recognized secret environment values; this does not sanitize arbitrary repository content or secrets unknown to the runner.

Back up both PostgreSQL and the state directory if history/artifacts matter. The checkout and runtime session stores are separate local state. Losing them cannot be repaired from DBOS checkpoints alone. Do not change a custom workflow's step order or rename projects while its runs are pending; use a new workflow version and finish or explicitly resolve existing runs first.

## Default workflow delivery

Issue Runs review validated local changes before committing. Blocking findings and
failed configured checks trigger at most two repair rounds by default. Each round
resumes implementation, reruns configured checks, and starts an independent review.

A ready result creates a non-draft request. Unresolved findings, failed checks, or
incomplete review create a draft with evidence and still complete the Run. Inspect
`readiness` and `reviewRounds` to distinguish delivery from readiness. Empty command
validation is skipped; agent-reported checks retain separate provenance. No-change
work creates no request. Operational failures do not become completed draft delivery.

Publication recovery reuses the final commit, review, draft decision and publication
identity, including incomplete draft summaries. It never repeats repair or review.
After a workflow-version change, recovery of old executions is refused; finish or
retire old work before using a fresh runner identity.
