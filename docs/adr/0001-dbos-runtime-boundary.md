# Use DBOS for durability, not application policy

DBOS owns durable workflow execution, checkpoints, and concurrency-one project
queues. Agent Workflows owns issue discovery, checkout policy, operator controls,
evidence, reconciliation, and application outcomes. This boundary provides DBOS
durability without introducing another workflow language or making a generic
scheduler responsible for coding-specific safety rules. Consequently, one
`Runner` owns the DBOS lifecycle per process, and application operations should
use `Operations.step()` so cancellation, phase events, checkout validation, and
redaction remain enforced. Raw DBOS steps remain available for advanced custom
workflows, but bypass those protections. A successful DBOS execution and the
application's terminal outcome are deliberately separate facts. Deterministic
tests therefore exercise the public runner and workflow boundary with real
PostgreSQL, temporary Git repositories, and controlled providers; crash recovery
tests restart against retained state, while live provider smoke tests remain a
separate concern.
