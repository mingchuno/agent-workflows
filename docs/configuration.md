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

## Profiles

A profile has `provider`, optional `model`, optional `reasoningEffort`, and optional `context`. Each stage merges its profile over project defaults. Switching provider discards the old provider's settings, so incompatible defaults cannot leak between providers. Each invocation starts a fresh session, including repeated custom steps.

Codex rejects `context`: its TypeScript SDK exposes no runtime context-budget/compaction controls. Explicit Codex model/effort settings are checked against the local runtime's `models_cache.json`, or a supplied `new SDKAgent("codex", {models})` catalog. A missing catalog fails clearly; omitted settings use runtime defaults and remain `unknown` in effective-profile records. The cache can be stale; refresh it using the authenticated Codex runtime when a newly available model is rejected.

Copilot queries its SDK model catalog for explicit settings. Supported context controls are `backgroundCompactionThreshold` and `bufferExhaustionThreshold`, fractions of context utilization, with defaults 0.8 and 0.95 when a partial context object is supplied. Background must be lower than exhaustion. These control compaction, not the model's hard context-window capacity. Hard capacity is recorded separately in tokens when the model catalog supplies it.

See [checked examples](../examples/config.ts). Model IDs in `modelOverrides` are placeholders that must be replaced with available models. No provider silently clamps or substitutes explicit options.

## Prompts and skills

`prompt` is literal stage text. `skills` contains paths to `SKILL.md` files, relative to the checkout or absolute. The runner snapshots their content and SHA-256 revision into invocation records and explicitly tells the agent to apply them. Copilot additionally receives skill directories; Codex receives explicit skill text. Automatic provider discovery is not assumed equivalent.

Stage timeout defaults to 30 minutes. Custom agent steps use the same `Stage` schema, profile resolution, snapshots, cancellation and session tracking as built-in stages. Credentials stay in environment variables/runtime authentication stores; do not place them in prompts or source files.
