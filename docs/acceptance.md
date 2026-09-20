# Phase 1 review guide

Implementation scope is the unchanged [specification in issue #1](https://github.com/mingchuno/agent-workflows/issues/1). Review the public contracts first, then the workspace/recovery boundaries. No task-specific worktrees, clones, merges or automatic review/fix loops are implemented.

| Acceptance area                                                     | Implementation / behavioral evidence                                                                                                                                  |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing checkout, clean startup, branch policy and base transition | `ExistingCheckout`; real Git tests cover dirty files, collisions, unresolved Git operations, mutation detection and next-task base                                    |
| Durable default workflow and extension                              | `Operations`, `defaultWorkflow`; PostgreSQL runner tests and the executable reporting-workflow example                                                                |
| Deduplication, one task/project, independent progress               | Instance-qualified task keys, DBOS concurrency-one queues; all four agent/host combinations and multi-project tests                                                   |
| GitHub/GitLab intake and publication                                | Octokit/Gitbeaker contracts; pagination, PR exclusion, label queries, custom GitLab root/credentials, draft MR and inline review fixtures                             |
| Agent profiles, SDKs, prompts and sessions                          | Isolated SDK workers; profile/default isolation, supported-setting rejection, SDK argument/event contracts and invocation records                                     |
| Validation and generated publication                                | Actual Git diff/fingerprints, schema-checked text; failed validation, malformed text, no-change and timeout tests                                                     |
| Recovery and external effects                                       | Process-level interruptions after edits, commit, push, request creation and review publication; blocked ambiguous agent recovery and no duplicate publication effects |
| Cancellation and ownership                                          | Real stubborn child process, journals, local leases, advisory locks; cancellation/reuse and duplicate-owner tests                                                     |
| Independent exact-revision review                                   | Fresh sessions, published diff/head context, added-line mapping and stale-head rejection                                                                              |
| Public observability and controls                                   | Store query/subscription, retained sessions, timestamps, artifacts, credential redaction, CLI JSON and explicit retries                                               |
| CLI/TUI                                                             | Init/error/help tests; keyboard step/session navigation, live state and action feedback; controls share application commands                                          |
| SDK documentation                                                   | Quickstart, configuration, API, providers, operations/recovery and type-checked examples; reporting example runs with controlled adapters                             |

## Local verification

Run `pnpm check`, `pnpm test`, `pnpm build`, and `pnpm lint`. Tests create a disposable PostgreSQL database unless `TEST_DATABASE_URL` is set, use real temporary Git repositories, and use controlled agents/hosting endpoints. `pnpm audit --prod` checks runtime dependency advisories. The GitHub Actions job supplies the same fixture boundary on Linux.

The implementation was verified locally on macOS with Node 24 and PostgreSQL 17. Remote CI has not run for this uncommitted working tree. No authenticated live Codex/Copilot model invocation, real GitHub publication or real GitLab instance smoke test was performed. Those require a deliberately chosen test repository and provider access and are separate from deterministic acceptance.

## Deliberate operational boundaries

- Interrupted agent work blocks if ownership/state is ambiguous; it never starts another writer merely because DBOS recovered.
- Explicit retry creates a new attempt from the base after the developer restores a clean checkout. It preserves the previous run and branch and does not silently amend an existing PR/MR.
- Runtime context controls are supported only where exposed by the provider; unknown defaults remain unknown. Codex explicit-model validation depends on its local model catalog or an injected catalog.
- Git hooks are disabled for the application-authored task commit; configure required checks as validation commands. Changed symlinks and submodules require manual handling.
- The runner assumes exclusive checkout use. It detects boundary changes but does not sandbox arbitrary custom adapters or prevent every unrelated local tool write.
- macOS/Linux process groups are required. Windows startup fails explicitly.

Human review should concentrate on cancellation/ownership, recovery reconciliation and adapter permissions before enabling unattended work on a real repository. Completion means the automation has published its draft and review, not that the code is approved.
