# Architecture decisions

These records explain durable design choices and their tradeoffs. User-facing
configuration, API contracts, and operating procedures remain in the main
documentation.

- [0001: Use DBOS for durability, not application policy](0001-dbos-runtime-boundary.md)
- [0002: Operate on existing checkouts under exclusive ownership](0002-existing-checkouts-and-exclusive-ownership.md)
- [0003: Separate runs from durable executions](0003-run-and-execution-identity.md)
- [0004: Ship the SDK, CLI, and TUI as one package](0004-single-package-boundary.md)
- [0005: Persist application state in PostgreSQL beside DBOS](0005-postgresql-persistence-boundary.md)

For observable behavior, see the [public SDK API](../api.md),
[configuration reference](../configuration.md), and [operator guide](../operations.md).
