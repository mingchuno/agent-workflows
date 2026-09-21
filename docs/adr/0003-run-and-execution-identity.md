# Separate runs from durable executions

A run represents one automation attempt and owns its branch, commit, publication
markers, and application history. Its initial DBOS execution uses the run ID.
Explicit retry creates a new run and branch; publication recovery preserves the
run but forks a new DBOS execution from the completed checkpoint prefix. Recovery
is limited to commit-backed, reconcilable publication effects: push, change-request
creation, and review publication. Agent work, validation, and custom workflows use
a fresh retry because DBOS does not snapshot the checkout. Retry and recovery
admission serialize under the project lock and persist the new identity before
dispatch, allowing uncertain dispatch responses to be reconciled after a crash.
Live code, configuration, artifact, checkout, and remote-state checks still run in
the first non-replayed operation; credential rotation is intentionally excluded
from the recovery fingerprint.
