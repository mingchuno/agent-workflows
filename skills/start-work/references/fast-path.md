# Fast path (Track A)

This session does the whole job and ends with a change request. Nothing is
persisted outside Git and the hosting provider. Publishing is the expected end
state; stop before pushing only when the human asked for local work.

1. Record the base revision with `git rev-parse HEAD`. If the checkout is on the
   default branch, create a branch such as `agent/<short-slug>`. Never work on a
   dirty checkout you did not create; ask first.
2. Implement the change. For a defect, add a regression test that fails before
   the fix.
3. Validate with the project's own checks. Use the configured `validation`
   commands from `agent-workflows --config CONFIG config show` when available, otherwise the
   commands in AGENTS.md or the package scripts. Read the full output. Report
   checks you could not run as limitations, never as passes.
4. Check the diff against the track. With the CLI, run
   `agent-workflows --config CONFIG work classify --project ID --file CONTRACT --changed-from BASE`.
   Without it, inspect `git diff --stat BASE` and untracked files against the
   step 3 rules in [start-work](../SKILL.md). If `escalation` is not empty or the
   diff no longer fits Track A, stop. Tell the human what grew, and continue on
   the higher track only after they agree.
5. Review the diff in fresh context. Prefer a subagent given only the diff, the
   intent and the acceptance criteria. Otherwise reread the whole diff once.
   Look for correctness, regressions, missing tests for the acceptance criteria
   and scope creep. Fix blocking findings in one round, then repeat step 3.
   Report anything left unfixed.
6. Commit with a conventional message, push the branch, and open the change
   request with `gh pr create` or `glab mr create`. The description states the
   intent, acceptance criteria, checks run with their results, and limitations.
   Reference the issue when one exists.
7. Reply with the change request URL, the checks and their results, and any
   limitations. Never merge.
