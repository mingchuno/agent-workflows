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
| `retry RUN`                        | Queue an explicit new attempt after checkout validation         |
| `monitor`                          | Attach an interactive terminal view                             |

Control commands return a command ID and `pending`; inspect `status --json` or the monitor for success/failure. With no runner, commands stay pending. Run and monitor are separate processes. Closing the monitor never cancels work. Ctrl-C on the runner stops intake, cancels active work, waits for process termination and releases ownership. Queued issues remain durable for the next start.

In the monitor, Left/Right selects a project, Up/Down a run, `[`/`]` a step/attempt event, Tab an agent invocation, `l` displays its log tail, `v` cycles validation logs, `p` pauses/resumes intake, `s` stops the selected run, `r` retries it, and `q` closes the view. Session IDs are displayed in full for terminal selection/copying. Outcomes, validation, profiles and session state use text as well as color. Noninteractive tools use `status --json` and `inspect`.

## Ownership and recovery

Only the runner may edit or switch managed checkouts while it is active. PostgreSQL advisory locks protect runner/configuration and checkout identities. A local Git-directory lease also prevents runners using different databases from owning the same checkout. Worker/validation process-group journals prevent reuse while old work may still run.

Startup and phase boundaries check ownership assumptions, branch/head and actual changes. Unfinished files are never reset, cleaned, stashed or discarded automatically. Dirty files, unresolved Git operations, branch collisions, unexpected mutations and ambiguous agent recovery become inspectable blocked states. Other eligible projects continue.

Publication effects have independent DBOS checkpoints. A task commit carries `Agent-Workflows-Run`; commit recovery checks parent and marker, push recovery checks the remote ref, request creation checks the source branch, and review publication checks stable markers. Transient publication failures use bounded retries and reconciliation. Interrupted agent stages block rather than starting another writer.

After a blocked/failed task:

1. Read `inspect RUN`, logs, session IDs and the local Git diff.
2. Establish that no worker/process group is still running. If startup reports an old PID or process journal, inspect that exact process and stop it before recovery. Never remove a live owner's lease.
3. Preserve unfinished work on a developer-owned commit/branch or move it to a safe location. Resolve merge/rebase state yourself. Do not rely on DBOS to restore files.
4. Once the checkout is clean, request `retry RUN`. This creates a new attempt and branch from the configured base, keeping the old run and files/commits inspectable.

A failed review after publication remains a failed automation attempt, even if its draft request exists. Explicit retry starts the full workflow as a new attempt; it does not silently modify the old request. Human review/merging remains separate. A stale review never claims coverage of a changed remote head.

## Evidence and limits

Validation records say exactly which command ran, when, its exit code and artifact path. No-change work skips publication. Generated commit/request text is validated and saved before Git/API writes. Logs, prompts and errors redact configured credentials and recognized secret environment values; this does not sanitize arbitrary repository content or secrets unknown to the runner.

Back up both PostgreSQL and the state directory if history/artifacts matter. The checkout and runtime session stores are separate local state. Losing them cannot be repaired from DBOS checkpoints alone. Do not change a custom workflow's step order or rename projects while its runs are pending; use a new workflow version and finish or explicitly resolve existing runs first.
