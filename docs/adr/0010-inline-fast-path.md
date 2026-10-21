# Run Track A inline and delegate only gated work

ADR 0009 sent every track through Work Items, PostgreSQL and the resident
worker. For a one-line fix, that cost more setup, tokens and waiting than asking
the interactive agent directly, which defeats the fast path.

`start-work` is the single entry skill. It classifies the task and follows one
protocol. Track A runs inline: the interactive session implements, validates,
reviews in fresh context, and opens the change request. It creates no Work Item
and needs no database or worker. Tracks B and C, whose value is recorded
revision-bound approval and unattended execution, stay delegated to the runner.

Classification stays deterministic where configuration exists.
`work classify` evaluates a contract and the actual diff against the project's
policy without persistence. A Track A diff that exceeds `fastTrackMaxFiles` or
touches a protected path escalates and stops before publication. Without
configuration, the skill classifies conservatively, and the human chooses
between setting up the backend and approving Track B or C scope in conversation.
Projects with SDLC enabled always delegate Track B and C.

Investigation, design and knowledge capture become references of `start-work`
instead of separate skills. Engineers learn one command, and the host loads one
skill description per session. A separate explicit-only `setup-agent-workflows`
skill performs onboarding, and `doctor` reports whether delegation is available.

Inline Track A work is not enforced by the runner. Team enforcement for it comes
from repository controls such as CI and protected branches, which also apply
to changes made without agents. This amends ADR 0009 for Track A; the runner
still accepts Track A Work Items from issue intake.
