# Separate Work Item authorization from execution

Work Items hold the assessed engineering contract. Runs remain attempts to
execute that work. Waiting for scope or design approval creates no Run and
occupies no DBOS queue slot. PostgreSQL owns Work Items, append-only approval
records, and atomic admission into the existing execution engine.

An agent recommends a track. Deterministic policy applies risk floors and
required gates. Track A needs a clear expected outcome. Track B needs approved
scope. Track C additionally needs approved design, a staged plan, verification
and rollback. A stricter requested track is retained.

Scope approval binds a canonical digest of scope, assessment, verification and
assessed source revision. Design approval binds the complete contract. Adding
a design preserves scope approval; changing scope invalidates dependent
approvals. Runs pin the complete contract revision. Source edits, policy
changes, and actual changed paths are checked again before execution, repair
and publication effects, including recovery.

SDLC is opt-in. Labels remain intake signals and cannot grant approval. The
same policy applies to local work, GitHub/Codex and GitLab/Copilot. Local work
has a real local subject and never fabricates a hosted issue.

Local operator approval provides auditability for personal pilots. An agent
sharing OS and database privileges can imitate that operator. Enterprise
deployments require authenticated allowed-human approval evidence and
credential separation. Provider identity alone does not establish authority.

This extends ADR 0005 without adding event-sourced projections or a second
scheduler. It also supersedes ADR 0006's writable reviewer/publication policy
for restricted stages once provider permission enforcement is enabled.
