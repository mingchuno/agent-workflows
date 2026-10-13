# Agent Workflows

Local durable coding workflows with a CLI, terminal monitor and bundled local
web app. Requires Node.js 22.12+ and PostgreSQL.

```sh
npm install -g @mingchuno/agent-workflows
agent-workflows init
# Configure your checkout, hosting credentials, agent and database.
agent-workflows run
```

The CLI automatically installs the exact matching `@mingchuno/agent-workflows-core`
version. The web monitor needs no separate installation or build.

For programmatic use, install and import `@mingchuno/agent-workflows-core`.
The CLI package does not export the SDK. Both packages share one version and
release cycle.

See the [setup guide](https://github.com/mingchuno/agent-workflows#readme),
[operator guide](https://github.com/mingchuno/agent-workflows/blob/main/docs/operations.md)
and [configuration reference](https://github.com/mingchuno/agent-workflows/blob/main/docs/configuration.md).
