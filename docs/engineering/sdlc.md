# Start and operate adaptive engineering work

Enable `sdlc.enabled` for a project to use Work Items before execution. Existing
projects keep label-based intake while SDLC is disabled. Use the
[personal example](../../examples/sdlc-personal.json) for local tasks with Codex
and GitHub. Use the [enterprise example](../../examples/sdlc-enterprise.json)
for issue-backed work with Copilot and GitLab. Replace repository, checkout,
approver, and validation settings before running either example.

## Choose a protocol

`start-work` is the only skill engineers invoke. It classifies the task and
follows one protocol ([ADR 0010](../adr/0010-inline-fast-path.md)).

| Track | Protocol | Needs |
| --- | --- | --- |
| A | Inline: the interactive session implements, validates, reviews and opens the change request. | Nothing beyond the agent and host CLI. With configuration, `work classify` enforces the project's floors. |
| B, C | Delegated: a Work Item waits for recorded approval, then the worker executes it. | Configuration, PostgreSQL, host credentials and a running worker. |

A Track A diff that exceeds `sdlc.fastTrackMaxFiles` (default 10) or matches a
protected path stops before publication and moves to Track B or C.

## How the track and clarity are decided

The agent records an assessment in the contract. Deterministic policy then
applies minimum tracks. The agent cannot lower them.

| Signal | Effect |
| --- | --- |
| An open question in `assessment.uncertainties` | At least Track B. Blocks readiness on every track until resolved. |
| `moderate` complexity | At least Track B. |
| `large` complexity, a declared risk flag, or a protected path in `riskRules` | Track C. |
| More expected or actual files than `fastTrackMaxFiles` | Track A becomes B. |

Unclear is not the same as risky. Clarification resolves open questions into
acceptance criteria, constraints and assumptions; it does not add a design gate.
`start-work` asks only questions that change acceptance, scope, safety or
feasibility, and records reversible defaults as assumptions.

You steer the result in three ways: answer or overrule an open question, ask for
a stricter `proposedTrack` (always kept), or edit the contract before approval.
Policy minimums cannot be lowered; change `riskRules` deliberately instead.

## Set up delegated work

1. Install the skill from the target project with the
   [Skills CLI](https://github.com/vercel-labs/skills), selecting the agent host.

   ```sh
   npx skills add mingchuno/agent-workflows --skill start-work
   ```

   For unpublished local changes, copy `skills/start-work` into
   `.agents/skills/`. Follow company policy for reviewed, pinned skill
   distribution or an internal mirror.
2. Invoke `$start-work` in Codex or `/start-work` in a Copilot host that supports
   slash invocation, with an issue or a task. When the task needs Track B or C
   and `agent-workflows doctor` reports a gap, the skill offers to set up the
   repository with you: it runs `agent-workflows init`, which infers the
   configuration from the repository, then works through each failing check.
   To do this by hand, run `init` and `doctor` yourself and follow
   [provider prerequisites](../providers.md).
3. Start the resident worker in its own terminal, and approve work in the web
   monitor it prints or in `agent-workflows monitor`.

   ```sh
   agent-workflows run
   ```

   Commands find the configuration as described in
   [configuration lookup](../configuration.md#configuration-lookup).

Confirm skill discovery with your agent host before relying on it.
The CLI persists contracts and enforces state transitions. The runner's
implementation and review stages keep their own prompts. Installing the skills
does not establish that an SDK-created session loads them.

## Keep the contract on the issue

Clarification produces the contract: context and findings, intent, acceptance,
scope, verification and, for Track C, the design. The issue is its canonical home
([ADR 0011](../adr/0011-publish-contracts-to-issues.md)). After the human confirms,
`start-work` publishes it before asking for approval.

```sh
agent-workflows --config agent-workflows.json work publish WORK_ID --revision CURRENT_REVISION --project app --json
```

| Work Item source | Effect |
| --- | --- |
| Local | Creates an issue titled from the contract, without labels, and rebinds the Work Item to it. |
| Issue | Replaces the Work Item's managed section in the issue body and keeps the reporter's text. |

The managed section sits between `agent-workflows:contract:WORK_ID` comment
markers. Edit the Work Item, not the section; any issue edit requires
reassessment. Publishing changes the observed source revision, so the Work Item
revision changes and earlier approvals no longer match. Approvers on the issue
therefore approve the contract they can read there.

Publication refuses a stale revision, an issue edited since it was observed, a
closed issue, and a Work Item with an active Run. Repeating it finds the issue
it created instead of creating another; an interrupted issue update needs a
reassessment first. Local Work Items need publication before a `github` or
`gitlab` approval source can approve them.

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
Local `work approve` rejects that policy. The published contract ends with the
exact comment for each gate, and `start-work`, `work inspect` and the monitors
show it for the gate awaiting approval. After reading the contract on the issue,
the approver posts it as a plain comment:

```text
/approve scope 3f9a2c1d4e5f
```

The code is a digest of the gate's contract content, so it names the contract
printed on the issue. A short comment counts only while the issue shows the Work
Item's current contract, and only when posted after the Work Item last changed,
so a comment from before a source edit or republication never approves the
reassessed work. That comparison uses the host's comment time and the local
clock; if a valid comment is ignored because of clock skew, post it again. The
long form `agent-workflows approve WORK_ID GATE REVISION` with the full Work
Item revision is still accepted.

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

The operator owns merge, production verification, and deployment. `start-work`
captures knowledge when the completed change establishes a durable decision or
domain invariant. Keep task plans and run evidence out of permanent domain docs.

## Verify a controlled pilot

Run these scenarios on disposable repositories before using a new runtime setup.

| Scenario | Evidence to inspect |
| --- | --- |
| `start-work` Track A request | One change request from the interactive session, no Work Item. |
| Oversized Track A diff | `work classify --changed-from` reports escalation before publication. |
| Hosted Track B request | No Run before current scope approval. |
| Published local Track B task | One unlabeled issue holds the contract; repeated publication reuses it. |
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
