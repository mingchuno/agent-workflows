# Ship two packages with one product version

The pnpm workspace contains two public npm packages:

- `@mingchuno/agent-workflows-core`: runtime and SDK, including provider adapters,
  configuration, workflow policy, persistence, migrations, recovery and shared
  operator policy.
- `@mingchuno/agent-workflows`: CLI, terminal monitor, web server and prebuilt
  browser assets. It depends on core; core never imports the application package.

This supersedes the original single-package decision. SDK consumers should not
install terminal or web dependencies, and package exports now enforce the seam
between workflow execution and its operator interfaces. CLI users retain their
package name, executable and one-step installation; SDK consumers import core.

Both packages always have the same version, including releases that change only
one package. A private root manifest is the product version authority. One root
Release Please configuration updates both package versions in one release PR,
with one `vX.Y.Z` tag, changelog and GitHub release. CI rejects version drift.
The CLI's `workspace:*` dependency becomes the exact core version when packed.
Independent deployment and versioning are outside this design.

One publishing job tests both tarballs before publishing core, then CLI. npm
publication is not atomic: a partial release can expose core before CLI. Retries
skip a published version only if its integrity matches the tested artifact.
Persistence and operator contracts evolve together through the shared version.

The web server still runs separately as decided in ADR 0008, and bundled assets
require no additional user installation or build.
