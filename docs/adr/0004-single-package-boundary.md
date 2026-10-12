# Ship the SDK, CLI, and monitors as one package

The public SDK, CLI, terminal monitor, and web monitor share a persistence schema
and release cycle. They ship as a single package, including prebuilt browser
assets, so the web monitor requires no additional user installation or build.
The web server runs in a separate process as decided in ADR 0008. Internal directories preserve
module boundaries without imposing cross-package compatibility and versioning
work on maintainers or consumers. The package should split only when a component
needs independent deployment or versioning. Until then, every release updates all
interfaces together, and pnpm workspaces remain an installation mechanism
rather than a public package boundary.
