# Architecture decisions

These records explain durable design choices and their tradeoffs. User-facing
configuration, API contracts, and operating procedures remain in the main
documentation.

- [0001: Use DBOS for durability, not application policy](0001-dbos-runtime-boundary.md)
- [0002: Operate on existing checkouts under exclusive ownership](0002-existing-checkouts-and-exclusive-ownership.md)
- [0003: Separate runs from durable executions](0003-run-and-execution-identity.md)
- [0004: Ship two packages with one product version](0004-single-package-boundary.md)
- [0005: Persist application state in PostgreSQL beside DBOS](0005-postgresql-persistence-boundary.md)
- [0006: Continue publication in the implementation session and inspect through commands](0006-agent-sessions-and-command-inspection.md)

- [0007: Review existing requests with a shared reviewer and stable publication identity](0007-review-workflow-and-publication-identity.md)
- [0009: Separate Work Item authorization from execution](0009-adaptive-sdlc-work-items.md)
- [0010: Run Track A inline and delegate only gated work](0010-inline-fast-path.md)
- [0011: Publish clarified contracts to the issue](0011-publish-contracts-to-issues.md)
- [0012: Onboard through start-work and existing sign-ins](0012-onboard-through-start-work.md)

For observable behavior, see the [public SDK API](../api.md),
[configuration reference](../configuration.md), and [operator guide](../operations.md).
