---
name: start-work
description: Start or resume engineering work from an issue, a task description, or a Work Item ID. Classifies the work into Track A, B, or C and follows the matching protocol, from a quick inline fix to approval-gated delegated execution.
---

# Start work

One entry point for engineering work. Classify first, then follow exactly one
protocol. Keep replies short: the track, the next action, and only decisions
that need the human.

## 1. Check the backend

Run `agent-workflows doctor` from the repository. If the command is missing,
treat the backend as absent. Read the JSON result.

| Result | Meaning |
| --- | --- |
| `protocols.delegated: true` | The project uses agent-workflows SDLC. Its policy is authoritative. |
| `sdlc` check fails, or no configuration | No SDLC policy applies. Track A still works inline. |
| Any other failing check | Delegated work is unavailable until it is fixed. Report the failing check and suggest the `setup-agent-workflows` skill. |

A `worker` warning only means admitted work waits until `agent-workflows run`
starts.

## 2. Resume or resolve the task

If the input is a Work Item ID, or `work list` shows a Work Item with the same
issue or local key, follow [the delegated protocol](references/delegated.md) to
resume it. Similar titles alone do not establish identity.

Otherwise, read the issue or task, then the relevant code, tests, domain context
and ADRs. Investigate before asking. Use [investigate](references/investigate.md)
when behavior is unclear or a defect needs a root cause.

## 3. Classify

Write a compact WorkContract JSON file outside the checkout. The fields are in
[the work API](references/work-api.md). Ask only questions whose answers change
acceptance, scope, safety or feasibility; record reversible defaults as
`assumptions`.

If the CLI and a configured project are available, run
`agent-workflows work classify --project ID --file CONTRACT` and use its
`track`. Otherwise classify by hand: Track A only for a small change with a
clear expected outcome, no declared risk, no open questions, and about ten files
or fewer. Migrations, security, public API, production, infrastructure and
cross-service changes are Track C. Everything else is Track B. When unsure,
choose the higher track.

## 4. Follow one protocol

| Track | Protocol |
| --- | --- |
| A | [Fast path](references/fast-path.md): this session implements, verifies, reviews and opens the change request. No Work Item, database or worker. |
| B or C, delegated available | [Delegated](references/delegated.md): record the Work Item, wait for recorded human approval, and let the runner execute. |
| B or C, no SDLC policy | Present the contract. Ask the human to choose: set up the backend with `setup-agent-workflows`, or approve the scope here and continue inline with the fast-path steps. Never choose for them. Record the approved scope in the change request. |

When SDLC is enabled, Track B and C work must use the delegated protocol.

Merging and deployment always remain with the human.
