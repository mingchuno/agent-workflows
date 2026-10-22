# Set up delegated work

Use this when `doctor` reports a failing check and the human wants Track B or C
work run by the worker. Track A never needs it. Change nothing before the human
agrees, ask one question at a time, lead with the recommended answer, and never
overwrite an existing configuration.

## 1. Explore (read only)

- `agent-workflows version`. If the command is missing, offer to install it:
  `npm install -g @mingchuno/agent-workflows`.
- `agent-workflows doctor --json` from the repository. Its `configPath` shows
  whether a configuration exists, including one in `$AGENT_WORKFLOWS_HOME`.
- PostgreSQL: a URL the human already uses, `pg_isready`, or Docker.

## 2. Write the configuration

When doctor found no configuration, run `agent-workflows init` in the repository
root. It infers the project, host and repository from `origin`, the base branch,
the agent runtime and the validation command, and enables SDLC with
`local-operator` approval. Show the human its summary and ask what to change.

- **Location.** The repository root suits one repository: commit the file if the
  team shares the policy, otherwise add it to `.git/info/exclude`. For several
  repositories, pass `--config ~/.config/agent-workflows/NAME.json`; the CLI
  finds the file whose project manages the current checkout. Before adding a
  second runner, check the collision conditions in the
  [operations guide](https://github.com/mingchuno/agent-workflows/blob/main/docs/operations.md#several-runners-on-one-database).
- **Approval.** Keep `local-operator` for personal projects; the human approves
  in the monitor. Team projects use `github` or `gitlab` with an `approvers`
  allowlist.
- **Policy.** Add `sdlc.riskRules` for paths that always need Track C, such as
  migrations or authentication.

## 3. Credentials and database

- **Hosting.** With `local-operator` approval, the CLI reuses the `gh` or `glab`
  sign-in when the token variable is unset. Otherwise ask the human to set the
  variable named by `hosting.tokenEnv`, or to opt in with
  `hosting.tokenFromCli: true`.
- **Database.** Offer the human's server or a local container such as
  `docker run -d --name agent-workflows-db -p 5432:5432 -e POSTGRES_PASSWORD=... postgres:17`.
  A Homebrew server on macOS needs `LC_ALL` set, for example
  `LC_ALL=en_US.UTF-8`.
- **Secrets.** Put the database URL and any token in an environment file outside
  the checkout with mode 600 and reference it with `envFile`. Never write a
  secret into the configuration or the conversation.

## 4. Verify

Rerun `agent-workflows doctor` until every check passes or only `worker` warns,
and fix what each failing check names. Then tell the human the two commands they
need: `agent-workflows run` in its own terminal, and `agent-workflows monitor`
(or the web link `run` prints) to approve work. Continue the original task.
