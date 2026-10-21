---
name: capture-knowledge
description: Check completed implementation and review evidence for durable domain or architecture knowledge. Propose a focused documentation update when future work needs it.
---

# Capture knowledge

Read the Work Item contract, final diff, review findings, and recorded validation.
Compare them with `CONTEXT.md`, applicable domain documentation, and `docs/adr/`.
Read the repository's own documentation conventions before proposing an edit.

Choose one outcome.

| Outcome | Use when |
| --- | --- |
| No durable knowledge change needed | The change follows existing decisions and adds no lasting invariant. |
| Propose domain documentation update | The implementation establishes or corrects vocabulary, a business invariant, or a maintained operational procedure. |
| Propose new or superseding ADR | The work establishes a durable architecture, persistence, security, external contract, or deployment decision. |

For a proposed change, identify the affected document, the exact fact or decision,
why future work needs it, and its implementation evidence. Keep temporary plans,
run transcripts, and task-specific acceptance criteria in the Work Item or Run.
Propose only knowledge supported by the completed change. Agent-reported checks
and unverified provider behavior remain labeled as such.

Apply the focused documentation edit when the user's authorized scope includes
it. Otherwise present the proposal. Completing a task alone does not justify a
new Markdown file or ADR.
