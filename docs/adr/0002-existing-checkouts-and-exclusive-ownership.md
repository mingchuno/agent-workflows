# Operate on existing checkouts under exclusive ownership

The default workspace operates directly on an existing local checkout and permits
at most one active task per project. PostgreSQL advisory locks protect runner and
configuration identities, while a Git-directory lease and process journals cover
runners using different databases and subprocesses that can outlive a crash. The
runner never resets, cleans, stashes, or discards unfinished work automatically;
ambiguous ownership or checkout state becomes a blocked outcome for human review.
This design preserves local context and makes recovery inspectable, at the cost of
serial work within each checkout. Higher per-project concurrency requires an
isolated-workspace lifecycle rather than a queue configuration change.
