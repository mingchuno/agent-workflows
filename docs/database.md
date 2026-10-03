# Database maintenance

`src/db/schema.ts` defines application tables in `agent_workflows`. Drizzle generates versioned SQL in `drizzle/`; its migration history lives in `agent_workflows_migrations`. DBOS owns its execution schema separately.

## Change the schema

1. Edit `src/db/schema.ts`.
2. Run `pnpm db:generate --name describe_change` and review the generated SQL and snapshot.
3. Run `pnpm test` against disposable PostgreSQL before applying the change. The test role needs `CREATEDB` for isolated migration fixtures.
4. Back up an existing database, stop runners, then run `AGENT_WORKFLOWS_DATABASE_URL=... pnpm db:migrate`.

Do not edit applied migration files or use schema push against existing data. Add a new migration for later changes. The migration command uses `AGENT_WORKFLOWS_DATABASE_URL`; with a custom `databaseUrlEnv`, supply that URL under this name for the command.

`Store.initialize()` also applies pending migrations, preserving automatic startup setup. A dedicated PostgreSQL advisory lock serializes migration attempts across processes. Build copies migrations into `dist/drizzle`, so the built runtime works outside the repository working directory; ship the whole `dist` directory.

The initial migration creates application tables in a fresh database. Databases with pre-Drizzle application tables are unsupported; use a fresh database. Databases with recorded Drizzle migration history continue to apply only pending migrations.

The persistence and locking rationale is recorded in
[ADR 0005](adr/0005-postgresql-persistence-boundary.md).
