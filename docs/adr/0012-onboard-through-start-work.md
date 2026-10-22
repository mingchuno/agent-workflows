# Onboard through start-work and existing sign-ins

ADR 0010 kept onboarding in a separate explicit-only `setup-agent-workflows`
skill. In practice an engineer met the gap inside `start-work`, when a Track B
task found delegation unavailable, and then had to learn a second skill name.
`init` wrote placeholders the engineer had to replace by hand, and a hosting
token had to be exported even when `gh` or `glab` was already signed in.

`start-work` is now the only skill. Setup is its reference, offered when
`doctor` reports a gap for Track B or C work, and it changes nothing without the
human's agreement. `init` infers the project from the repository instead of
writing placeholders, and `doctor` reports each gap with its fix. This amends
ADR 0010's onboarding paragraph; the inline and delegated protocols are
unchanged.

The CLI reads a missing hosting token from the host CLI's sign-in. That is the
engineer's own credential, which a same-account agent can already use, so it
adds no authority for `local-operator` projects. Provider approval relies on
keeping the approver's credentials apart from the runner's, so those projects
must opt in with `hosting.tokenFromCli`. The token lands in `tokenEnv` in the
CLI process only, so redaction and SDLC subprocess filtering treat it like an
exported token. SDK callers still prepare their own environment.
