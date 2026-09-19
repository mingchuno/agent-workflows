# Phase 1 implementation checklist

Scope: [SPEC](../SPEC.md), published as issue #1. Existing checkouts only;
PostgreSQL stores application records and DBOS execution history.

- [x] Configuration, profiles, adapter and workspace contracts
- [x] Real Git workspace lifecycle and process cancellation
- [x] PostgreSQL records, ownership, event/query surface
- [x] DBOS queues, default workflow, custom operations
- [x] GitHub/GitLab adapters and reconciliation
- [x] Codex/Copilot SDK adapters and session tracking
- [x] CLI and monitor TUI using shared commands
- [x] Recovery/failure injection and behavioral acceptance tests
- [x] SDK reference, operational guides and checked examples
- [x] Final acceptance audit and [human review notes](acceptance.md)

Dependencies: DBOS (MIT), Zod (MIT), Commander (MIT), Ink/React (MIT),
Drizzle ORM (Apache-2.0), node-postgres (MIT), Pino (MIT), Octokit (MIT), Gitbeaker (MIT),
Copilot SDK (MIT), Codex SDK (Apache-2.0). Node >=22.12; lockfile pins
installed versions. No real agent/provider invocation is part of routine tests.
