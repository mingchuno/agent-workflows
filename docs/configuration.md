# Configuration

The CLI reads `agent-workflows.json`, or `--config PATH`. Unknown properties are rejected by Zod. Paths are local filesystem paths; checkout paths are canonicalized before ownership is acquired. Use absolute paths when launching from different working directories.

| Runner field     | Default / meaning                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| `id`             | Required stable letters/digits/underscore/hyphen identity; scopes records and queues                      |
| `databaseUrlEnv` | `AGENT_WORKFLOWS_DATABASE_URL`; environment variable containing a PostgreSQL connection URL with username |
| `stateDirectory` | `.agent-workflows`; persistent local artifact directory                                                   |
| `projects`       | Nonempty array; duplicate IDs or canonical checkout roots are rejected                                    |

| Project field          | Default / meaning                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `id`, `checkout`       | Required stable identity and existing Git repository root                                           |
| `hosting`              | `provider` (`github`/`gitlab`), web `origin`, `repository`, and `tokenEnv`; no serialized tokens    |
| `labels`               | `['ready-for-agent']`; all labels must match                                                        |
| `baseBranch`, `remote` | `main`, `origin`; Git remote is independent of hosting API origin                                   |
| `branchTemplate`       | `agent/{issue}-{attempt}`; `{issue}` required; `{attempt}` and `{run}` supported                    |
| `pollIntervalMs`       | 30000; minimum 100                                                                                  |
| `gitIdentity`          | Required `name` and `email`; used by application commits                                            |
| `validation`           | Array of `{command,args,timeoutMs}`; no shell expansion; timeout defaults to 300000 ms              |
| `agent`                | Required default profile                                                                            |
| `stages`               | `implementation`, `writing`, `review`; each has optional `profile`, `prompt`, `skills`, `timeoutMs` |

Issues are selected in ascending issue-number order within each intake scan. Deduplication persists across restarts. An explicit retry is a new numbered attempt linked through `retryOf`.

## CLI environment files

Select one file explicitly for any CLI command:

```sh
agent-workflows --env-file ./runner.env run
agent-workflows --env-file ./runner.env status --json
agent-workflows --env-file /absolute/path/runner.env monitor
```

Example `runner.env` (replace placeholders locally):

```dotenv
AGENT_WORKFLOWS_DATABASE_URL="postgresql://USER:PASSWORD@localhost/agent_workflows"
GITHUB_TOKEN="YOUR_GITHUB_TOKEN"
APP_MODE=development # unquoted comment
APP_GREETING="hello # literal text"
APP_REFERENCE='${APP_MODE}'
```

- Existing process values win, including empty strings. Empty required database
  or hosting values still fail existing validation. Missing keys are filled from
  the file; arbitrary application variable names are supported. `databaseUrlEnv`
  and `hosting.tokenEnv` still select which names the runner uses.
- Relative paths resolve from the CLI launch directory, independently of
  `--config` and project checkouts. Absolute paths work too. No `.env` discovery
  or multiple-file layering is performed.
- Parsing uses Node's literal dotenv syntax: quotes and comments are supported;
  `$NAME`, `${NAME}`, backticks and `$(command)` in values are not expanded or
  executed. This is not shell sourcing.
- The file is read once before the command action, database access, hosting
  adapters or runner creation. Missing or unreadable files stop the command with
  a nonzero exit and a path/error code, without printing file contents. Restart
  the runner to pick up edits. Help only displays usage and does not load files.
- The merged environment is shared across all projects in the runner. Validation,
  Git and agent worker subprocesses inherit it. Provider runtimes may apply their
  own environment policies to tools they launch; see [providers](providers.md).
  No per-project environment isolation is added.

Keep local environment files out of version control. Add their actual names to
`.gitignore` (or `.git/info/exclude`), especially inside managed checkouts where
untracked files interfere with cleanliness checks. Do not copy credentials into
configuration, prompts or issue bodies. Existing database/hosting credential
redaction remains in effect; arbitrary variable support does not classify every
application value as a secret. A GitHub API token does not configure Git push
credentials.

The flag belongs to `agent-workflows`, not the separate `pnpm db:migrate` command.
SDK callers load their own process environment before creating a runner and
continue passing `databaseUrl` explicitly. Node startup-only settings, such as
`NODE_EXTRA_CA_CERTS`, must be set before launching Node to affect the CLI process.
When invoking the script directly through Node, separate Node arguments from
application arguments: `node -- dist/src/cli.js --env-file ./runner.env status`.

## Profiles

A profile has `provider`, optional `model`, optional `reasoningEffort`, and optional `context`. Each stage merges its profile over project defaults. Switching provider discards the old provider's settings, so incompatible defaults cannot leak between providers. Each invocation starts a fresh session, including repeated custom steps.

Codex rejects `context`: its TypeScript SDK exposes no runtime context-budget/compaction controls. Explicit Codex model/effort settings are checked against the local runtime's `models_cache.json`, or a supplied `new SDKAgent("codex", {models})` catalog. A missing catalog fails clearly; omitted settings use runtime defaults and remain `unknown` in effective-profile records. The cache can be stale; refresh it using the authenticated Codex runtime when a newly available model is rejected.

Copilot queries its SDK model catalog for explicit settings. Supported context controls are `backgroundCompactionThreshold` and `bufferExhaustionThreshold`, fractions of context utilization, with defaults 0.8 and 0.95 when a partial context object is supplied. Background must be lower than exhaustion. These control compaction, not the model's hard context-window capacity. Hard capacity is recorded separately in tokens when the model catalog supplies it.

See [checked examples](../examples/config.ts). Model IDs in `modelOverrides` are placeholders that must be replaced with available models. No provider silently clamps or substitutes explicit options.

## Prompts and skills

`prompt` is literal stage text. `skills` contains paths to `SKILL.md` files, relative to the checkout or absolute. The runner snapshots their content and SHA-256 revision into invocation records and explicitly tells the agent to apply them. Copilot additionally receives skill directories; Codex receives explicit skill text. Automatic provider discovery is not assumed equivalent.

Stage timeout defaults to 30 minutes. Custom agent steps use the same `Stage` schema, profile resolution, snapshots, cancellation and session tracking as built-in stages. Credentials stay in environment variables/runtime authentication stores; do not place them in prompts or source files.
