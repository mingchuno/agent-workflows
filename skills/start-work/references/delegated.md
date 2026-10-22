# Delegated protocol (Tracks B and C)

The runner owns implementation, validation, review, repair and publication after
admission. This session records the contract and moves it through the gates. Read
[the work API](work-api.md) before issuing work commands.

1. Resume an existing Work Item when `work list` shows the same ID, issue or
   local key. Otherwise create one: `work create --issue N` for issue work, or
   `work create --title TEXT --key KEY` with a stable local key.
2. Submit the contract with `work propose`, using the exact revision returned by
   the last inspection. Then inspect again and follow `decision.state`, not a
   track inferred from the conversation. `decision.trackReasons` explains the
   effective track.

| State | Next action |
| --- | --- |
| `needs-info` | Resolve the returned reasons and propose a revised contract. |
| `awaiting-scope-approval` | [Publish the contract](#publish-the-contract), then present intent, acceptance, scope paths, risk and revision. Wait for recorded approval. |
| `design` | Follow [design](design.md), then propose the design on the current contract. |
| `awaiting-design-approval` | [Publish the contract](#publish-the-contract), then present the design, verification, rollback and revision. Wait for recorded approval. |
| `ready` | Run `work submit` with the exact current revision, then report the returned Run. |

The worker admits ready work on its next poll, so an approval can start
execution without another prompt. Repeated submission returns the existing Run.

## Publish the contract

The issue is the contract's canonical home, so reviewers and approvers read it
there. Before presenting a gate, publish the current revision with
`work publish`. The first time for a Work Item, ask the human first: "Create an
issue holding this contract?" for local work, or "Update issue #N with this
contract?" for issue work. Publish only after an explicit yes. Once confirmed,
republish without asking whenever a proposal changes the contract, in one step
with `work propose --publish`. If the human
declines, continue unpublished and do not ask again for that Work Item.

Publishing returns a new revision and resets approvals; present that revision.
When `approvalSource` is `github` or `gitlab`, tell the human that local work
cannot be approved until it is published.

## Approval

Approval is a human action. Tell the human exactly where to give it, in one
line:

- `approvalComment` in the inspection: "Comment on the issue: `/approve scope 3f9a2c1d4e5f`".
  It counts only from an allowed approver, after the contract was last published.
- Otherwise, with `monitorUrl`: "Approve here: MONITOR_URL". Without it: "Start
  `agent-workflows run`, then approve with `agent-workflows monitor --web WORK_ID`
  or `a` in `agent-workflows monitor`."

The worker continues on its own after approval; do not wait in a loop. Never run `work approve`, post an approval comment,
or treat labels or agreement in conversation as a recorded approval. For
provider approval, `work sync-approvals` imports existing human comments.

If a command rejects a stale revision, inspect before proposing again. Re-read
the Work Item after an approval, a source edit or a fresh session.

Report the Work Item ID, effective track, state and one next action. Report a
Run ID only after the backend returns one. An escalated Run needs a human
decision before scope grows. After the human agrees to the revised scope,
propose it and present the gate as usual. Once the Work Item is ready again,
tell the human to preserve and clean the checkout, then resubmit from the
monitor (`r` in the terminal monitor, or "Resubmit after recovery" in the web
monitor). It checks that earlier processes stopped and the checkout is clean.

After Track C delivery, follow [capture knowledge](capture-knowledge.md).
