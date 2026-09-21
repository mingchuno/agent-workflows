# Ship the SDK, CLI, and TUI as one package

The public SDK, CLI, and terminal monitor share one runtime, persistence schema,
and release cycle, so they ship as a single package. Internal directories preserve
module boundaries without imposing cross-package compatibility and versioning
work on maintainers or consumers. The package should split only when a component
needs independent deployment or versioning. Until then, every release updates all
three interfaces together, and pnpm workspaces remain an installation mechanism
rather than a public package boundary.
