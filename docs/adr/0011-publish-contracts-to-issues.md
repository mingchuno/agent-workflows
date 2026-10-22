# Publish clarified contracts to the issue

Clarification turns a vague prompt or ticket into a Work contract: context and
findings, intent, acceptance, scope, verification and design. That contract lived
only in PostgreSQL and the final change request. An issue kept its original text,
and local work had no ticket at all. Reviewers and approvers could not read the
spec where the team tracks work, and the context was lost with the database.

The issue is the canonical home for a Track B or C contract. `work publish`
writes the current contract into a managed, marker-delimited section of the issue
body. It replaces that section for issue-backed work and preserves the reporter's
text. For local work it creates an unlabeled issue and rebinds the Work Item's
source to it. ADRs stay for durable decisions; the issue holds work-specific
context.

Publication changes the observed issue revision, so it changes the Work Item
revision and invalidates earlier approvals. This is deliberate: issue revisions
cover the body, so an approval binds the contract text a human can read on the
issue. A second source-binding rule to carry approvals across would weaken that.
`start-work` publishes before requesting approval, so normally nothing is lost.

Publication is idempotent through the section marker. A repeated publication of
local work finds the issue it created instead of creating another. Any unobserved
issue change, including an interrupted update, requires reassessment rather than
an overwrite, because an interrupted write cannot be told apart from a human
edit. Publication waits while a Run is active.

This amends ADR 0009's rule that local work "never fabricates a hosted issue".
A published issue is real: a human confirms creating it, and it carries the
assessed contract rather than invented provenance. Local work may still stay
unpublished. Track A remains inline and issue-optional under ADR 0010.
