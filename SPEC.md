# Agent Workflows: local orchestration SDK — Phase 1

Status: Phase 1 specification; test boundary confirmed by the user.

## Problem Statement

Developers want to turn eligible repository issues into implemented, validated and reviewed pull requests or merge requests using agents on their local development machine. Today they must manually coordinate issue selection, branch creation, agent sessions, validation, commit messages, publication and review.

They need to define that process programmatically, change between GitHub and GitLab or between GitHub Copilot and Codex, and add custom steps without rewriting the workflow. A local, sequential process per project is sufficient initially, while independent projects must be able to progress concurrently.

## Solution

Provide a TypeScript SDK and a local CLI with an interactive TUI built on DBOS. Developers configure projects, choose hosting providers and per-stage agent/model settings, supply prompts or skills, and compose ordinary DBOS workflows using reusable coding-workflow operations. GitLab support includes GitLab.com and self-hosted installations. SDK-specific documentation explains configuration, extension and operation alongside links to DBOS documentation.

The default workflow discovers labelled issues, selects each issue once, creates a branch in the project's existing clean checkout, implements the task, runs configured validation, generates commit and PR/MR text through an agent, publishes the change, runs an independent agent review and posts its findings. Completion releases the project to process its next issue; human merging is separate.

Phase 1 runs at most one task workflow per project. It creates no per-task clones, worktrees or remote workspaces. One local runner manages multiple project queues and shares one PostgreSQL instance. Workflow progress is persisted; local files and agent sessions remain on the machine.

## User Stories

1. As a developer, I want to initialise a local project configuration, so that I can start without assembling the workflow infrastructure myself.
2. As a developer, I want the runner to use my local machine and PostgreSQL, so that I do not need a hosted deployment.
3. As a developer, I want to register an existing repository checkout, so that Phase 1 does not require additional workspaces.
4. As a developer, I want to configure GitHub or GitLab for each project, so that my workflow supports either hosting provider.
5. As a developer, I want configurable provider endpoints and credential references, so that authentication and repository location are not embedded in workflow code.
6. As a developer, I want to configure the issue label that enables agent work, so that I control which tasks are eligible.
7. As a developer, I want the runner to poll for eligible issues, so that local operation does not require a public webhook endpoint.
8. As a developer, I want repeated polling to avoid duplicate runs, so that one issue does not cause repeated work.
9. As a developer, I want eligibility rechecked before execution, so that removed labels or closed issues prevent stale work from starting.
10. As a developer, I want one active task per project, so that agents do not compete for the same checkout.
11. As a developer, I want independent projects to run concurrently, so that one long task does not block unrelated repositories.
12. As a developer, I want a configurable base branch and branch-naming rule, so that generated branches follow my project conventions.
13. As a developer, I want a dirty checkout or unresolved Git operation to block task startup, so that existing work is preserved.
14. As a developer, I want to select Copilot or Codex for implementation, so that I can choose the agent appropriate to the project.
15. As a developer, I want to provide an implementation prompt or skill, so that the agent follows the project's instructions.
16. As a developer, I want to configure validation commands, so that completion is checked against project-specific requirements.
17. As a developer, I want validation results and the actual diff inspected before publication, so that an agent's success message is not the only evidence.
18. As a developer, I want an agent to draft commit messages from the actual changes, so that commits communicate the work accurately.
19. As a developer, I want an agent to draft PR/MR titles and descriptions, so that change requests explain the problem, solution and validation.
20. As a developer, I want to supply separate writing prompts or skills, so that commit and change-request text follows my conventions.
21. As a developer, I want generated publication text saved before Git or API writes, so that retries reuse the reviewed generation result.
22. As a developer, I want validated changes committed, pushed and published as a PR/MR, so that I can inspect the outcome in my usual repository host.
23. As a developer, I want PR/MR publication retries to find an existing change request, so that transient failures do not create duplicates.
24. As a developer, I want a separate agent session to review the published revision, so that implementation is checked independently.
25. As a developer, I want to select the reviewer independently from the implementer, so that Copilot and Codex can be combined in either direction.
26. As a developer, I want review findings tied to a commit, so that stale feedback is not represented as a review of newer changes.
27. As a developer, I want review findings posted to the PR/MR, so that the review is available alongside the code.
28. As a developer, I want the next issue to begin after publication and review complete, so that the queue does not wait for a human merge.
29. As a developer, I want failed, blocked, cancelled and no-change outcomes to be explicit, so that I know which tasks need attention.
30. As a developer, I want to inspect progress, logs and validation evidence, so that I can understand a run without reconstructing terminal history.
31. As a developer, I want to stop work and retry a selected failed task, so that I retain control over the local runner.
32. As a developer, I want restart recovery to account for existing agent processes, files, commits and PRs/MRs, so that recovery does not duplicate or destroy work.
33. As an SDK user, I want to insert custom steps and define different workflows in TypeScript, so that the default issue-to-review sequence is a starting point rather than a fixed product constraint.
34. As an SDK user, I want provider changes to leave workflow logic unchanged, so that integrations remain interchangeable.
35. As a future maintainer, I want checkout handling isolated behind a workspace interface, so that per-task Git worktrees and higher per-project concurrency can be introduced later.

36. As a developer, I want to connect to self-hosted GitLab on a custom hostname, so that my organisation's repositories are supported without using GitLab.com.
37. As a developer, I want to choose the model and reasoning effort separately for each agentic stage, so that implementation, writing and review can use different quality and cost settings.
38. As a developer, I want to configure context-related limits where supported, so that I can control context use within the selected model and runtime's capabilities.
39. As a developer, I want unsupported model settings rejected clearly, so that the runtime does not silently ignore my requested behavior.
40. As an SDK user, I want documentation for the SDK's own APIs, configuration and extension contracts, so that I can build workflows without reading its implementation.
41. As an SDK user, I want working examples of custom steps and provider selection, so that I can adapt the SDK to a different workflow.
42. As a developer, I want an interactive terminal view of projects, queues, runs and steps, so that I can observe local execution in one place.
43. As a developer, I want to pause project intake, resume intake, stop an active run and retry failed work from the TUI, so that I can operate workflows without switching interfaces.
44. As a developer, I want to find every agent session associated with a run and step attempt, so that I can trace implementation, writing and review back to their runtime sessions.
45. As an SDK user, I want the same run and session information through a programmatic interface and machine-readable CLI output, so that my own tooling can consume it.
46. As a maintainer, I want established open-source libraries used for standard infrastructure concerns, so that the project concentrates custom code on coding-workflow behavior.

## Implementation Decisions

- **Foundation:** Use TypeScript, Node.js and DBOS. Keep DBOS's workflow and step model visible to SDK users. PostgreSQL is the only required additional infrastructure service; native PostgreSQL or a local container are both acceptable.
- **Product shape:** Build reusable SDK operations, a local runner CLI/TUI, SDK documentation and an initial configuration/prompt scaffold. Avoid a second workflow language, a generic workflow engine or a plugin marketplace.
- **Domain vocabulary:** A project identifies a configured repository and checkout. An issue is a candidate task. A run is one execution attempt of a workflow. A change request means either a GitHub PR or GitLab MR. Agent roles are implementer, publication writer and reviewer; these roles need not use different providers.
- **Project configuration:** Include stable project identity, canonical checkout location, hosting-provider connection, repository identity, eligibility labels, base branch, branch policy, polling interval, validation commands, role-specific agent settings and prompt/skill references. Keep credentials outside serialised configuration and workflow results.
- **Self-hosted GitLab:** Support GitLab.com and explicitly configured self-hosted GitLab instances, including custom origins and supported relative URL roots. Resolve API endpoints and issue/MR links from the configured instance; never hard-code GitLab.com. Keep Git clone/push remote configuration separate from the web/API URL. Scope credentials, repository identities and deduplication keys to the instance so identical project identifiers on different hosts do not collide. Respect configured certificate trust for private installations without disabling TLS verification by default. Document and test the supported GitLab version range during implementation.
- **Per-stage agent profiles:** Allow each agentic stage, including custom steps, to select its agent provider, model, reasoning effort and supported context settings. Resolve settings from project defaults with explicit per-stage overrides; record the requested and effective profile for every invocation. Implementation, publication writing and review may all use different profiles. An override must take effect even when another stage used a different model or provider; start a fresh session where the runtime cannot safely change those settings in an existing session.
- **Capability-aware settings:** Validate profiles against adapter and model capabilities before the affected agent stage starts. Distinguish the model's context-window capacity from runtime context budgets or compaction controls; configuration cannot enlarge a model's hard limit. Expose supported context controls with clear semantics and units. Reject unsupported or incompatible explicit options rather than silently ignoring, clamping or substituting them. Permit omission to use documented provider defaults, and identify unresolved effective values as unknown rather than inventing them. Any provider-specific extensions must be namespaced and documented.
- **Established OSS dependencies:** Prefer maintained open-source libraries for schema validation, CLI parsing, terminal rendering, provider API clients, logging and other standard infrastructure. Zod, Citty, Commander.js, oclif and Ink are candidate examples, not a requirement to install all of them. Select one suitable library per concern where practical, check license/runtime compatibility, and document the choice. Write custom code for domain behavior and integration gaps; do not hand-build commodity frameworks already served by appropriate dependencies.
- **Scheduling:** Use one project queue with global concurrency one. One queue item owns the complete issue workflow through review publication or a terminal outcome. Polling is separate from task execution. Projects use distinct queues and can run concurrently within one process. Phase 1 rejects settings above one concurrent task per project.
- **Local ownership:** Enforce a single runner for a given local runner configuration and exclusive ownership of each canonical checkout. Reject duplicate registrations that would permit multiple project queues to write to the same checkout. Other manual tools must not edit or switch that checkout during a run; the runner detects unexpected changes at phase boundaries and stops when ownership assumptions fail.
- **Issue intake:** Implement GitHub and GitLab polling through provider adapters, including pagination and label filtering. Exclude PRs from GitHub issue intake. Persist issue/run identity so repeat scans do not repeatedly start the same task. Revalidate eligibility at execution time. Explicit retry creates a new attempt linked to the original task.
- **Existing-checkout workspace strategy:** Phase 1 validates and uses the configured checkout directly. Before starting new work, require a clean checkout with no in-progress merge or rebase. Resolve the configured remote/base commit and create a branch using the configured policy. Never discard changes or overwrite a conflicting branch automatically.
- **Workspace lifecycle:** Keep workspace acquisition, verification, recovery and release behind one interface. Phase 1 implements only the existing-checkout strategy. A successful task leaves a clean, published branch; the next task prepares its branch from the configured base, not from the previous task branch.
- **Failure with local changes:** Preserve unfinished files and branch state. Mark the task terminal and inspectable, but block further writes in that project until recovery or developer action restores an eligible checkout. A failed task must not release unsafe checkout state to another agent. Other projects may continue.
- **Agent adapters:** Implement Copilot through GitHub Copilot SDK and Codex through Codex SDK. Normalise invocation, working directory, streamed events, completion, session references and cancellation. Surface unsupported capabilities explicitly. Swapping provider or model must not require changes to the workflow's step sequence.
- **Prompts and skills:** Support explicit prompts for each agentic stage and adapter-specific skill loading. Instruct the agent to apply the selected skill. Record the effective prompt/skill revision or snapshot for each run; do not assume identical automatic discovery behavior across providers.
- **Default workflow:** Eligibility/claim, checkout preparation and branch creation, implementation, validation, publication-text generation, content validation, commit, push, PR/MR creation, independent review, review publication and completion. External effects and agent calls execute inside durable steps; distinct publication effects have separate checkpoints and reconciliation.
- **Validation:** Execute project-configured commands and inspect actual repository changes. Failed validation blocks successful publication. No relevant diff produces a no-change outcome. Agent output must distinguish executed validation from unrun or failed checks.
- **Agent-authored publication:** Supply issue context, diff and validation evidence to the publication writer. Require validated structured output containing commit message, change-request title and description. Persist it before publication. Generation may use the configured agent's available output mechanism followed by application-level schema validation; provider capabilities need not be identical.
- **Git publication:** Application code performs staging, commit and push using the generated text and a verified change set. Default to one task commit. Explicitly configured Git identity supplies authorship. Checkpoint resulting commit IDs and reconcile actual Git state on restart instead of blindly committing again.
- **Hosting-provider publication:** Create a draft PR/MR by default, link the source issue, and persist the change-request identity. Reconcile by stable repository/branch/run identity when an API response is uncertain. Provider adapters own GitHub/GitLab differences.
- **Review:** Use a fresh reviewer session with the issue requirements, published diff, exact head commit and validation evidence. Store structured findings and publish a summary plus inline findings where valid locations exist. Recheck the remote head before publication; if it changed, mark review stale and require a new review rather than claiming coverage of the new revision.
- **Completion boundary:** The initial task ends when the PR/MR and independent review are published. Findings may be present; completion means the automation finished, not that the code is approved. Automatic review/fix cycles and merging are excluded from Phase 1.
- **Persisted records:** DBOS owns execution history and step checkpoints. Application records associate project, issue, attempt, phase, checkout, base/head commits, agent sessions, generated text, validation evidence, change-request identity, review revision and terminal outcome. Keep large logs as local artifacts referenced from persisted records.
- **Public observability:** Expose a documented SDK query/event interface for project, run, step and attempt state. Correlate every agent invocation with the project, run ID, stable step identity, attempt/invocation identity, provider, effective agent profile and provider session/thread ID. Capture session identifiers as soon as the adapter supplies them, not only on successful completion. Retain multiple sessions across retries or multiple invocations instead of overwriting the previous ID. Report pending or unavailable IDs explicitly. Make historical records discoverable after a restart. Expose timestamps, outcomes and log/artifact references; redact credentials and avoid logging sensitive environment values. Session inspection/resumption instructions must state provider support rather than promise a universal session-opening command.
- **Recovery:** Reconcile an interrupted stage against agent/session state and actual checkout/remote state. Recover only when ownership and state are established. Otherwise preserve evidence and mark blocked. A saved DBOS checkpoint is not a filesystem snapshot or a running-process checkpoint.
- **Cancellation and retries:** Use bounded timeouts and retry policies. Propagate cancellation to agent processes and validation commands; confirm work has stopped before reusing the checkout. Retry transient API failures through reconciliation, not unconditional agent restarts. A blocked or failed issue is not automatically rediscovered as fresh work.
- **CLI:** Provide initialisation, running selected projects, inspecting status/logs, stopping work and explicitly retrying failures. Report missing prerequisites and configuration errors before issue execution. Shutting down should stop intake and manage in-flight work without losing its identity.
- **TUI:** Provide a keyboard-operated terminal interface for project queues, run lists, step progress, logs, validation results, agent profiles and session IDs. Support selecting a run/step/attempt, copying or displaying session identifiers, pausing/resuming new work for a project, stopping an active run and explicitly retrying eligible failed work. Pausing intake prevents new task starts, including already queued tasks, while the active task may finish; it is distinct from cancelling a running task. Actions must use the same application commands and checks as the CLI, expose pending/success/failure state, and preserve checkout ownership. Closing a monitoring view does not implicitly cancel work. Document runner-versus-monitor lifecycle and keep noninteractive commands and machine-readable output available.
- **SDK documentation:** Deliver a local quickstart, prerequisites/authentication guide, configuration reference, public API reference, workflow/custom-step examples, agent profile and skill guidance, provider capability matrix, GitLab self-hosting configuration, CLI/TUI operation, observability/session lookup and recovery/troubleshooting guidance. Explain the SDK's domain operations and contracts; link to DBOS documentation for DBOS concepts instead of duplicating it. Include an end-to-end example and examples of per-stage model settings and custom workflows. Maintain examples against the public API and document limitations and defaults as part of Phase 1 acceptance.
- **Future scaling:** Raising a queue limit alone is insufficient while tasks share a checkout. A later release can introduce per-run worktrees behind the workspace interface, then enable higher concurrency with checkout isolation, branch uniqueness, local tool resource allocation and lifecycle cleanup. Workflow composition and agent/hosting adapters should remain usable unchanged.

## Testing Decisions

- **Confirmed test boundary:** Test primarily through the public runner/workflow API with real local PostgreSQL, temporary real Git repositories and controlled agent/hosting-provider adapters. Assert observable outcomes and externally visible artifacts rather than private helpers, internal call order or DBOS implementation details.
- **Contract coverage:** Use small adapter contract suites where the public workflow tests cannot establish provider compatibility. Cover both Copilot and Codex, and GitHub and GitLab. Routine automated tests use deterministic fixtures; explicitly invoked smoke tests exercise configured real providers and report exactly what was verified.
- **Composition:** Run the same default workflow across all four implementer/hosting-provider combinations. Exercise cross-provider independent review. Demonstrate adding a custom validation or reporting step without editing provider code.
- **Scheduling behavior:** Prove one active task per project, ordering under configured intake policy, and simultaneous progress in two distinct projects. Prove duplicate polling does not create a second run and duplicate checkout registrations cannot bypass exclusivity.
- **Checkout behavior:** Cover clean startup, dirty checkout, branch collision, unresolved merge/rebase, unexpected checkout mutation and transition to a new issue from the configured base. Prove failed work is preserved and blocks unsafe reuse while other projects continue.
- **Publication behavior:** Assert generated messages/titles/descriptions are used, schema failures prevent writes, validation evidence is accurate, and no-change/failed-validation outcomes do not create a successful change request.
- **Failure injection:** Interrupt after agent edits, commit, push, remote change-request creation and review publication. Restart and assert no duplicate writers, commits, PRs/MRs or review posts; ambiguous recovery must block rather than guess.
- **Process lifecycle:** Test cancellation and timeout with a real controlled child process, including a process that does not stop immediately. Confirm another task cannot acquire the checkout while old work still runs.
- **Review behavior:** Confirm fresh reviewer sessions, correct revision context, mapping of valid inline findings and rejection of stale review publication after a head change.
- **CLI behavior:** Exercise configuration errors, initialisation, status visibility, shutdown and explicit retry through observable CLI results. Keep most workflow coverage at the public API boundary for speed and clearer failures.
- **Self-hosted GitLab behavior:** Exercise a non-GitLab.com origin and a relative URL root using a controlled HTTP endpoint. Assert API routing, generated issue/MR links, credential scoping and host-qualified identity; no request may accidentally go to GitLab.com. Include supported-version adapter fixtures and document any real-instance smoke verification separately.
- **Agent profile behavior:** Prove different stages receive their selected provider/model/reasoning/context settings, defaults and overrides resolve correctly, and unsupported explicit options fail visibly before invocation. Test profile changes that require a new session and the distinction between requested settings and observable effective settings.
- **Observability behavior:** Query and subscribe through the public SDK surface; assert run-to-step-attempt-to-session correlation for active, successful, failed, retried and recovered work, including multiple invocations and missing IDs. Verify machine-readable CLI output and credential redaction.
- **TUI behavior:** Exercise keyboard navigation, live state updates, step/session inspection and action outcomes through user-visible terminal behavior. Assert pause prevents new starts, stopping awaits process termination, retry respects checkout eligibility and closing a monitor leaves the runner's tasks intact. Test noninteractive operation without requiring a TUI. Reuse application-level behavioral coverage instead of duplicating the whole workflow suite through terminal rendering.
- **Documentation validation:** Type-check or execute applicable SDK examples against the public API with controlled providers. Verify documented configuration examples and the quickstart prerequisites; keep provider credentials and paid calls out of routine documentation checks.
- **Prior art:** This is a new project with no existing code, tests, glossary or ADRs. These boundaries are proposed rather than inherited; no runtime compatibility or recovery behavior is claimed tested yet.

## Out of Scope

- More than one concurrent task within a project in Phase 1.
- Creating or managing task-specific Git worktrees, clones, containers or remote execution environments.
- Hosted operation, distributed worker fleets, public webhook infrastructure, web dashboards or multi-user access control. The local terminal UI is included in Phase 1.
- Implementing another general-purpose scheduler, workflow language or interchangeable workflow-engine backend.
- Agent providers beyond Copilot and Codex, or repository platforms beyond GitHub and GitLab. Self-hosted GitLab is included in Phase 1.
- Automatic merging, automatic review/fix loops, multi-commit planning, unattended destructive cleanup or automatic conflict resolution.
- Guaranteeing exactly-once external effects without reconciliation, or recovering arbitrary lost local files from DBOS state alone.
- Preventing all writes from unrelated local tools; Phase 1 relies on exclusive checkout use plus detection at boundaries.

## Further Notes

- The user explicitly chose the existing checkout to keep Phase 1 simple. Workspace isolation remains an interface and a later implementation, not a hidden Phase 1 worktree requirement.
- A terminal workflow failure and a checkout safe for another task are separate conditions. This distinction preserves unfinished work without stopping unrelated projects.
- This specification records the agreed direction; detailed API names, package layout and dependency versions will be selected during implementation against current documentation.
- The user confirmed the test boundary required by the to-spec skill.
- Publish this specification to the mingchuno/agent-workflows GitHub issue tracker with the ready-for-agent label.
