---
name: setup-agent-workflows
disable-model-invocation: true
description: Set up agent-workflows for the current repository so start-work can delegate Track B and C work. Run once per repository, or when agent-workflows doctor reports a failing check.
---

# Set up agent-workflows

Explore, present what you found, confirm with the human, then write. Ask one
question at a time and lead with the recommended answer. Change nothing before
the human confirms, and never overwrite an existing configuration.

## 1. Explore (read only)

- `agent-workflows version` and `agent-workflows doctor`. If doctor already
  passes, report that and stop.
- `git remote -v`: GitHub or GitLab, origin and `OWNER/REPOSITORY`.
- An existing configuration: what `agent-workflows doctor` reports as
  `configPath`, which also searches `$AGENT_WORKFLOWS_HOME`.
- `gh auth status` or `glab auth status`, and which of `codex` or `copilot` is
  installed and signed in.
- PostgreSQL: a URL the human already uses, `pg_isready`, or Docker.
- Validation commands from AGENTS.md or the package scripts.

## 2. Decide with the human

1. **Goal.** Track A works inline with no setup. Recommend full setup only when
   the human wants approval-gated Track B and C work run by the worker.
2. **Configuration location.** For one repository, recommend
   `agent-workflows.json` at the repository root with `checkout: "."`,
   committed if the team shares the policy, otherwise listed in
   `.git/info/exclude`. For several repositories or a dedicated directory,
   put each configuration in `$AGENT_WORKFLOWS_HOME` (default
   `~/.config/agent-workflows`) with an absolute `checkout`; the CLI finds the
   one that manages the current checkout. Before adding a second runner, check
   the four collision conditions in the
   [operations guide](https://github.com/mingchuno/agent-workflows/blob/main/docs/operations.md#several-runners-on-one-database).
3. **Database.** PostgreSQL is required. Offer the human's existing server, or
   a local container such as
   `docker run -d --name agent-workflows-db -p 5432:5432 -e POSTGRES_PASSWORD=... postgres:17`.
   A Homebrew server on macOS needs `LC_ALL` set, for example
   `LC_ALL=en_US.UTF-8`, or it fails at startup.
4. **Approval source.** `local-operator` for personal projects. For team
   projects, use `github` or `gitlab` with an explicit `approvers` allowlist.

## 3. Write

1. Install the CLI if missing, after the human agrees:
   `npm install -g @mingchuno/agent-workflows`.
2. Run `agent-workflows init` in the repository root, adding `--config PATH`
   for a file outside it. It refuses to overwrite.
3. Edit the generated file: project `id`, `hosting`, `agent.provider`,
   `validation`, and `sdlc` (`enabled: true`, `approvalSource`, `approvers`).
   Keep `stateDirectory` outside the checkout.
4. Put secrets only in an environment file outside the checkout with mode 600,
   referenced by `envFile`: the database URL variable named by
   `databaseUrlEnv`, and the hosting token variable named by
   `hosting.tokenEnv`. Never write a secret into the configuration or the
   conversation.
5. Install the entry skill:
   `npx skills add mingchuno/agent-workflows --skill start-work`.

## 4. Verify

Run `agent-workflows doctor` until every check passes or only `worker` warns.
Tell the human to start the worker in its own terminal with
`agent-workflows run`, and that `/start-work` (or `$start-work`) is now the
only command they need.
