---
name: start-work
description: Start or resume engineering work from an issue, a local task, or a persisted Work Item. Investigate requirements and advance the authoritative Track A, B, or C workflow through agent-workflows.
---

# Start work

Use this skill for interactive intake. The runner owns implementation, validation,
review, repair, and publication after admission.

1. Resolve the repository, configuration path, and configured project. Read its
   agent instructions and domain documentation. Use the existing
   `agent-workflows` CLI. Read [the work API](references/work-api.md) before
   issuing work commands.
2. Run `work list` and inspect an existing Work Item when its ID, source identity,
   or explicit local key matches the request. Resume that record. A similar title
   alone does not establish identity.
3. For new issue work, fetch the issue and relevant permitted comments. Create
   the Work Item with `work create --issue`. Resolve ticket aliases through an
   approved issue tool to the configured host's numeric issue ID. Ask for the
   mapping if the result is ambiguous. For local work, choose a stable intake
   key and use `work create --title --key`.
4. Read relevant code, tests, domain context, and ADRs before asking questions.
   Use [investigate-work](../investigate-work/SKILL.md) when requirements or
   behavior remain unclear. Write material unresolved questions into
   `assessment.uncertainties`. Record reversible defaults in `assumptions`.
5. Write a complete WorkContract JSON file outside the source checkout. Keep the
   observed source references and expected behavior concise. Select only
   repository-configured validation profiles. Submit it with `work propose`
   using the exact revision returned by inspection.
6. Inspect again. Follow `decision.state` rather than a track inferred from the
   conversation.

| State | Next action |
| --- | --- |
| `needs-info` | Resolve the returned blockers and propose a revised contract. |
| `awaiting-scope-approval` | Present intent, acceptance, scope boundaries, risk, and revision to the human operator. Wait for recorded approval. |
| `design` | Use [design-change](../design-change/SKILL.md), then propose the design on the current contract. |
| `awaiting-design-approval` | Present the design, verification, rollback, and revision to the human operator. Wait for recorded approval. |
| `ready` | Submit the exact current revision, then inspect the returned Run. |

The resident runner can admit a ready Work Item on its next poll. A successful
proposal or approval may therefore start execution without another prompt.
Repeated submission returns the existing admission for that revision.

Approval is a human operator action. Never invoke `work approve`, manufacture an
approval record, or treat ticket labels or conversational agreement as a stored
approval. Re-read the Work Item after an approval, source edit, or fresh session.
For provider-backed approval, `work sync-approvals` imports existing permitted
human approval comments. The worker also syncs them during polling. Never post
an approval comment on the human's behalf.
If a command rejects a stale revision, inspect before making a new proposal.

Report the Work Item ID, effective track, current state, and one next action.
Report a Run ID only after the backend returns it. Keep agent-reported checks
separate from recorded workflow validation. An escalated Run requires a human
decision before expanding scope. Merging and deployment remain with the human.

After implementation, use [capture-knowledge](../capture-knowledge/SKILL.md) for
Track C or when the change establishes a durable domain or architecture decision.
