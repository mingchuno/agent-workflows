# Persist application state in PostgreSQL beside DBOS

Agent Workflows requires PostgreSQL for application records and stores them in the
`agent_workflows` schema through Drizzle; DBOS owns its execution schema separately
in the same database. The `Store` owns typed record access, row and project locking,
and atomic admission and event writes. Fixed parameterized PostgreSQL session-lock
calls are the only application-level raw SQL exception because Drizzle has no
equivalent. Execution history remains in the run JSON record so publication
recovery can evolve without a table backfill, while large agent and validation
artifacts remain on the local filesystem. This keeps transactional workflow state
queryable without turning PostgreSQL into a log store, but complete recovery and
backup require both the database and state directory. JSON-backed full-history
queries may sort in memory until scale justifies typed indexed columns.
