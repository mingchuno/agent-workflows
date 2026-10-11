# Operating the local runner

## CLI and monitor

Start the runner and attach the monitor in separate terminals:

```sh
agent-workflows run
# In a second terminal:
agent-workflows monitor
```

All commands accept `--config PATH` before the subcommand. For example,
`agent-workflows --config ./work.json monitor`.

| Command | Effect |
| --- | --- |
| `init` | Write a starter config; refuse overwrite |
| `run [--project ID ...]` | Start selected projects in the foreground |
| `reload [--timeout-ms MS]` | Reload configuration and prompt files; wait for acknowledgement |
| `status [--json]` | Show projects, runs and command outcomes |
| `inspect RUN` | Show complete run and invocation/session records as JSON |
| `logs RUN [--invocation ID]` | Read local stage, agent and validation artifacts |
| `pause PROJECT` / `resume PROJECT` | Pause/resume new intake |
| `stop RUN` | Cancel work; success means active local work has stopped |
| `recover RUN` | Continue failed publication using completed checkpoints |
| `retry RUN` | Request a new attempt after checkout validation |
| `retry RUN --refresh-issue` | Request a new attempt using the current hosted issue |
| `monitor [--notify]` | Attach the TUI; optionally enable outcome notifications |

Control commands return a command ID with `pending`. Check `status --json` or the
monitor for acknowledgement; with no runner, commands stay pending. Closing the
monitor leaves work running. Ctrl-C on the runner stops intake, cancels active
work, waits for processes to stop and releases ownership. Queued tasks remain
available for the next start.

### Reload configuration

`reload` waits up to 10 seconds for acknowledgement. A timeout leaves the command
pending; it does not cancel it. Use `--timeout-ms` to change the wait. See
[what can be reloaded](configuration.md#live-reload).

Use the same absolute configuration path and startup database environment as the
runner. Reload can still reach that runner when edited JSON is invalid or its ID
has changed. Without an active local control record, it fails before submitting
anything. The owner-only record lives in the OS temporary directory, contains
identity metadata without credentials, and is removed on normal shutdown or
replaced after the old process exits. SDK runners use the Store command channel.

## Monitor

Use an interactive terminal of at least 80×24. At 112 columns and above, the run
list and selected-run workspace appear side by side. Smaller terminals open the
workspace with Enter. Subject, state, phase and attempt stay visible while you
scroll evidence. To try it without a database, use the
[local mock preview](../README.md#preview-the-tui).

### Find a run

- Left/Right changes project; Up/Down selects a run.
- `f` cycles All, Attention, Active, Queued and Finished. Attention includes
  failed, blocked and cancelled runs.
- `/` searches the current project's references, titles, project and run IDs.
  Search is literal and case-insensitive. Enter applies it; Esc cancels editing.
  To clear it, open `/`, delete the query and press Enter.
- `n` clears search, switches to Attention and selects the next run needing action.

Polling keeps selection stable, even when the selected run leaves its filter.
It stays visible until you navigate or reapply discovery. A brief notice reports
state changes without moving focus.

### Investigate a failure

Start in Overview: read the failed operation, recorded evidence and suggested next
checks. Provider messages identify possible causes; they are not verified diagnoses.
Press `d` for the full diagnostic or `x` for available actions and restrictions.
Retry creates a new run and branch. Recovery continues publication in the same run
using checkpoints; the runner rechecks eligibility before acting.

| Workspace key | Section or action |
| --- | --- |
| `1` / Enter | Overview |
| `2` | Activity |
| `3` | Checks |
| `4` | Executions, queue waits and durations |
| `5` / `d` | Diagnostics |
| `6` | Technical: exact IDs, paths, profiles and timestamps |
| `7` / `x` | Actions and eligibility reasons |
| `t` | Expand/collapse the full subject in Overview |
| Tab / Shift+Tab | Next/previous section |
| Up/Down, PgUp/PgDn, Home/End | Scroll evidence |
| Esc | Return to the list with selection intact |

Execution duration excludes queue waiting and gaps before recovery. Terminal
execution durations freeze at completion. Missing timing evidence is shown as
not started, not recorded or unavailable.

### Controls and logs

| Context | Keys |
| --- | --- |
| Dashboard | Tab/Shift+Tab switches run, overview and session focus; `a` focuses sessions |
| Controls | `p` pauses/resumes intake on the dashboard; `s` stops; `r` retries; `F` retries with refreshed issue; `c` recovers; `R` reloads configuration |
| Logs | `l` opens the selected session log, or the latest running invocation/stage diagnostic in the workspace; `v` opens validation logs |
| Log navigation | Up/Down or `j`/`k` scroll; PgUp/PgDn pages; Left/Right pans; Home/End or `g`/`G` first/last page; `f` resumes follow |
| Log presentation | Tab selects next log; `R` toggles readable/raw; `/` searches; `n`/`N` next/previous match |
| Help | `?` opens grouped shortcuts; Tab/Shift+Tab or Left/Right changes category; Up/Down scrolls |
| Close | Esc dismisses search/help before leaving logs; `q` or Ctrl-C closes the monitor |

Stop, retry and recovery open a confirmation dialog with Cancel selected.
Tab/Shift+Tab or Left/Right selects Cancel or Confirm; Enter activates it and
Esc cancels. The footer offers the primary run action; `x` explains the others.
Pending commands remain visible while switching projects. Search and log input
cannot send workflow commands.

Log search covers the entire selected file and wraps at its boundaries. Lowercase
queries ignore case; any uppercase character makes the query case-sensitive.
Scrolling or searching pauses follow. Known agent events become readable messages
and tool activity; unknown events remain JSON. Raw mode preserves stored text
except unsafe terminal control codes.

### Connection and appearance

The monitor refreshes state and open logs every 400 ms. Database connectivity
does not prove the runner is alive. Loading, confirmed empty, unavailable and stale
are distinct states. A failed refresh keeps the last snapshot and disables run
controls until refresh succeeds. Evidence-query failures appear separately.

The palette uses terminal colors by default. Set `AW_TUI_THEME=light` or `dark`
for a matching semantic palette, `NO_COLOR=1` to disable colors, or `AW_TUI_ASCII=1`
for ASCII punctuation. `TERM=dumb` disables color and selects ASCII automatically.
Unicode subjects and diagnostic content retain their original text.

### Desktop notifications

`monitor --notify` emits one notification when an execution first reaches
completed, failed, blocked, cancelled, no-change or ineligible. The initial
snapshot is silent; later terminal executions across all visible projects are
included, even after reconnection. Alerts use OSC 9 and are best-effort: they are
not persisted, retried or acknowledged, and delivery failure does not affect runs.

Supported terminals include iTerm2, Kitty, WezTerm and Ghostty. Windows Terminal
is unsupported. Terminal permissions and foreground-alert settings control
whether notifications appear. Under tmux 3.3+, enable `set -g allow-passthrough on`
yourself; the monitor adds one layer of DCS passthrough wrapping.

Alerts contain only `agent-workflows: <project> · <issue reference> · <outcome>`.
They exclude titles, diagnostics, paths and internal identifiers.

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
