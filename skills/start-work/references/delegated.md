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
| `awaiting-scope-approval` | Present intent, acceptance, scope paths, risk and revision. Wait for recorded approval. |
| `design` | Follow [design](design.md), then propose the design on the current contract. |
| `awaiting-design-approval` | Present the design, verification, rollback and revision. Wait for recorded approval. |
| `ready` | Run `work submit` with the exact current revision, then report the returned Run. |

The worker admits ready work on its next poll, so an approval can start
execution without another prompt. Repeated submission returns the existing Run.

Approval is a human action. Never run `work approve`, post an approval comment,
or treat labels or agreement in conversation as a recorded approval. For
provider approval, `work sync-approvals` imports existing human comments.

If a command rejects a stale revision, inspect before proposing again. Re-read
the Work Item after an approval, a source edit or a fresh session.

Report the Work Item ID, effective track, state and one next action. Report a
Run ID only after the backend returns one. An escalated Run needs a human
decision before scope grows.

After Track C delivery, follow [capture knowledge](capture-knowledge.md).
