---
status: accepted
---

# Start a local web monitor with workflow execution

The `run` command starts a localhost-only web monitor alongside workflow
execution. The workflow engine remains independent of the web interface, which
provides inspection and the terminal monitor's operator actions; the existing
TUI remains available. Direct remote access is outside the scope.

The CLI manages the web server as a child process with its own database and
evidence access. It submits operator commands through the existing persisted
command queue; the Runner retains command policy and workflow execution.
Web startup failure or a later crash produces a terminal warning without
stopping workflows. The web process ends with its parent `run`; closing the
browser does not stop execution. Offline browser inspection is outside this
scope.

Prebuilt browser assets and the web server ship in the CLI npm package
and shared product release, following ADR 0004's two-package design. Users need no
additional installation, build step, or separately launched service; existing
Node and PostgreSQL requirements remain. A standalone executable is unnecessary.

The monitor starts by default on a documented port. Startup flags disable it
or select another port. An occupied port produces a warning without switching
ports or stopping workflows. The CLI prints the access URL without opening a
browser automatically.

The printed URL grants launch-specific access without a separate login or
token-entry step. The server accepts operator actions only from its own browser
origin and confines evidence access to the configured workflow state. These
protections support the local-only boundary without adding accounts or user
setup. Live status and log updates are included; browser notifications are not.
