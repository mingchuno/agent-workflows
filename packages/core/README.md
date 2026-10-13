# Agent Workflows core

Durable coding workflow runtime and SDK on DBOS. Requires Node.js 22.12+ and
PostgreSQL.

```sh
npm install @mingchuno/agent-workflows-core
```

```ts
import { Runner, Store, createAgents, createHosting } from "@mingchuno/agent-workflows-core";
```

Core owns workflow execution, configuration, persistence and migrations,
provider adapters, recovery, and command policy. It has no CLI, TUI or web app
dependencies. The `./operator` export provides shared action availability,
evidence confinement, redaction and the CLI's default validation timeout.
Runner/Store remain authoritative for command admission and execution.

Install `@mingchuno/agent-workflows` for the CLI and bundled monitors. Both
packages always share one version and release cycle.

See the [SDK guide](https://github.com/mingchuno/agent-workflows/blob/main/docs/api.md),
[configuration reference](https://github.com/mingchuno/agent-workflows/blob/main/docs/configuration.md)
and [examples](https://github.com/mingchuno/agent-workflows/tree/main/examples).
