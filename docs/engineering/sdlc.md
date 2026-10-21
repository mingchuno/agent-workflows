# Start and operate adaptive engineering work

Enable `sdlc.enabled` for a project to use Work Items before execution. Existing
projects keep label-based intake while SDLC is disabled. Use the
[personal example](../../examples/sdlc-personal.json) for local tasks with Codex
and GitHub. Use the [enterprise example](../../examples/sdlc-enterprise.json)
for issue-backed work with Copilot and GitLab. Replace repository, checkout,
approver, and validation settings before running either example.

## Start the worker and intake session

1. Configure PostgreSQL and authenticate the selected host and agent runtime as
   described in [provider prerequisites](../providers.md).
2. Keep the state directory outside the source checkout. Start the resident worker.

   ```sh
   agent-workflows --config agent-workflows.json run
   ```

3. Install all four repository skill directories into the interactive runtime's
   project skill directory. Once the skills exist in your distribution branch,
   use the existing [Skills CLI](https://github.com/vercel-labs/skills) from the
   target project and select the intended agent host.

   ```sh
   npx skills add mingchuno/agent-workflows \
     --skill start-work \
     --skill investigate-work \
     --skill design-change \
     --skill capture-knowledge
   ```

   For unpublished local changes, copy those four folders from `skills/` into
   `.agents/skills/`. Preserve their names and sibling references. Follow company
   policy for reviewed, pinned skill distribution or an internal mirror.
4. In an interactive Codex session, invoke `$start-work` with an issue or task.
   In a Copilot host that supports slash invocation, use `/start-work`. Confirm
   discovery with that host before relying on it. IDE invocation differs by host.

The primary entry point is the conversational skill. The existing CLI persists
contracts and enforces state transitions. No separate `devflow` tool is required.
The runner's implementation and review stages retain their own prompts. Installing
the intake skills does not establish that an SDK-created session loads them.

## Inspect and approve work

The intake skill returns a Work Item ID and effective track. Read its current
contract and decision before approving.

```sh
agent-workflows --config agent-workflows.json work inspect WORK_ID --project app --json
```

Track A can become ready after an expected outcome is recorded. Track B waits for
scope approval. Track C waits for scope approval, then a complete design and
design approval. An unresolved material uncertainty prevents admission on every
track. Read the [contract reference](task-contract.md) for field and revision rules.

For a personal pilot using `approvalSource: local-operator`, run the operator
command yourself after inspecting the exact complete revision.

```sh
agent-workflows --config agent-workflows.json work approve WORK_ID --revision CURRENT_REVISION --gate scope --project app
agent-workflows --config agent-workflows.json work approve WORK_ID --revision CURRENT_REVISION --gate design --project app
```

Use only the gate currently required. Design approval requires a design. The
intake skill never runs these commands. Conversational agreement and issue labels
do not create approval records.

The worker admits a ready Work Item on its next poll. Final approval can therefore
start implementation without another prompt. Polling skips a Work Item whose
current revision is already admitted or whose attempt is still active. A Work Item
that fails during polling records a `work-poll-error` event without blocking other
work in the project. With the worker stopped, ready work
remains persisted. A later worker start resumes intake. Explicit submission uses
the same eligibility checks and returns an existing admission for the same revision.

```sh
agent-workflows --config agent-workflows.json work submit WORK_ID --revision CURRENT_REVISION --project app --json
agent-workflows --config agent-workflows.json status --json
agent-workflows --config agent-workflows.json inspect RUN_ID
```

## Resume or correct a task

Start a fresh agent session and invoke `start-work` with the Work Item ID, hosted
issue, or original local key. The skill lists and inspects persisted work before
proposing changes. Avoid creating a second local key for the same task.

If an issue changed, fetch it and reassess its current behavior and scope. A new
proposal records the current assessed source revision. Changed scope requires
new approval. A stale proposal or approval fails rather than replacing newer work.

If the actual diff exceeds approved paths or raises the required track, inspect
the blocked Run and preserve the checkout. Resolve the scope change with the
operator. Do not broaden paths or downgrade the recommendation merely to pass
admission. Use the existing retry or publication recovery controls only after the
recorded safety checks permit them.

## Keep enterprise approval independent

The enterprise example requires GitLab approval by the configured allowed human.
Local `work approve` rejects that policy. After inspecting the current contract,
the human posts this exact plain comment on the source issue.

```text
agent-workflows approve WORK_ID scope CURRENT_REVISION
```

For the design gate, the human substitutes `design` and the complete revision
they inspected. The runner reads source-host comments and accepts only configured
human approvers at the current revision. It ignores bots, outsiders, and stale
comments. The intake agent never posts approval comments. Configuration loading
rejects a `github` or `gitlab` approval source without a nonempty `approvers` list.

The worker imports permitted approval during polling. To import existing comments
without waiting for another poll, run the sync command.

```sh
agent-workflows --config agent-workflows.json work sync-approvals WORK_ID --project service --json
```

Keep approval credentials separate from implementation credentials. Configure the
host's branch and account controls so the agent cannot act as an allowed human.
SDLC agent and validation subprocesses omit configured runner database and hosting
environment variables, including aliases with the same credential values. Use
separate model-authentication credentials or the runtime's stored login. A hosting
token used as the only Copilot authentication variable is deliberately omitted.
This environment filter does not isolate files, parent processes, or services
accessible to the same OS account. Enterprise credential isolation requires a
separate execution account or container with appropriately restricted access.

An agent with the same OS account and PostgreSQL privileges as the operator can
imitate a local approval. Local attribution provides an audit trail for a personal
pilot. It does not establish an enterprise identity boundary. Confirm authenticated
source comments and credential separation before unattended company execution.

## Check the result and release it

When source or scope escalation blocks a project, preserve unfinished work and
clean the checkout before starting another attempt. Reassess the Work Item and
record its required approvals. Submit the new revision explicitly with
`work submit WORK_ID --revision CURRENT_REVISION --project app --recover`.
This checks that recorded processes have stopped and the checkout is clean before
atomically clearing the block and admitting the revised work. It preserves an
operator pause. Automatic polling never clears a recovery block.

Inspect workflow-executed validation, independent review, limitations, and final
readiness. Outstanding manual checks, missing configured validation, or incomplete
review prevent fully verified readiness. A completed draft Run is delivered work
that still needs attention.

The operator owns merge, production verification, and deployment. Use
`capture-knowledge` when the completed change establishes a durable decision or
domain invariant. Keep task plans and run evidence out of permanent domain docs.

## Verify a controlled pilot

Run these scenarios on disposable repositories before using a new runtime setup.

| Scenario | Evidence to inspect |
| --- | --- |
| Local Track A request | One Work Item and one Run without planning approval. |
| Hosted Track B request | No Run before current scope approval. |
| Track C migration | No Run before current scope and design approval. |
| Fresh interactive session | The same Work Item resumes without reconstructing a prompt. |
| Issue or scope edit | Prior authorization no longer admits the changed work. |
| Protected path in an unexpected diff | Escalation occurs before repair or publication. |
| Incomplete checks or review | The result never claims fully verified readiness. |
| Repeated submission | One committed admission for the same revision. |

Repository fixture tests exercise deterministic policy, database state, and
controlled provider behavior. They do not prove live Codex or Copilot skill
discovery, model behavior, or authenticated enterprise approval. Record those live
checks separately for the specific installed runtimes and credentials.
