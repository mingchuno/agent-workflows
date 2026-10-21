---
name: design-change
description: Propose the technical design for controlled engineering work after scope approval. Use when a Work Item enters design or the user requests a bounded architecture decision.
---

# Design change

Read the current Work Item and [the work API](../start-work/references/work-api.md).
Use the approved acceptance criteria and path boundaries as the design limits.
If inspection still requires scope approval, return that gate to the operator.

Inspect the affected components, contracts, data lifecycle, and relevant ADRs.
Compare significant alternatives. Prefer the existing mechanism when it satisfies
the approved behavior. A design that expands scope needs a scope proposal first.

Add a `design` object to the complete current contract.

| Field | Required content |
| --- | --- |
| `summary` | Proposed approach and affected interfaces or data contracts. |
| `alternatives` | Significant rejected approaches and the tradeoff behind the choice. |
| `stages` | Bounded implementation stages with observable completion conditions. |
| `verification` | Checks for success, failure, and integration boundaries. |
| `rollback` | Recovery or rollback method, with irreversible consequences stated. |
| `references` | Evidence and existing decisions. |

Put the decision itself in the approved object. A mutable document link is not a
substitute for design content. Use an ADR proposal only for a durable choice
future maintainers need to understand.

Return the design to [start-work](../start-work/SKILL.md) for `work propose` using
the inspected revision. Present the revised contract for human design approval.
The backend preserves scope approval when only design changes. Scope edits
invalidate dependent approval. Never invoke the operator approval command.
