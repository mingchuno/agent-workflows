# Releases

Two public npm packages share one product version: `@mingchuno/agent-workflows-core`
contains the runtime/SDK and migrations; `@mingchuno/agent-workflows` contains the
CLI, TUI, web server and browser assets. The private root manifest supplies the
version; Release Please updates both package manifests through `extra-files`.
Every release publishes both packages, even when only one changes. The CLI's
`workspace:*` dependency is packed as the exact matching core version.

Release Please opens one version/changelog PR from Conventional Commits on
`main`. Merging it creates one `vX.Y.Z` tag and GitHub release and, when
`NPM_PUBLISH_ENABLED=true`, publishes both packages to npm. Fixes bump patch,
features bump minor, and breaking changes bump minor before 1.0.

## Configuration

- The release GitHub App needs Contents, Pull requests and Issues read/write.
  Actions secrets `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY` provide its
  credentials. App-created release PRs trigger CI.
- Squash commits use the PR title and description. Protect `main` with `check`
  and `commitlint`; preserve `!` or `BREAKING CHANGE:` for breaking changes.
- The `npm` environment restricts deployment to `main`. Environment reviewers
  are optional; merging the release PR is the normal release decision.
- npm trusted publishing uses GitHub Actions owner `mingchuno`, repository
  `agent-workflows`, workflow `release.yml`, environment `npm`, and permission
  to publish directly. Configure the same trusted publisher for both npm packages.
  It authenticates independently of the GitHub App via
  OIDC; no `NPM_TOKEN` is required. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
- The repository variable `NPM_PUBLISH_ENABLED=true` enables publication.
  Unset it or set it to `false` to pause future publishing. Inspect active runs
  separately: they may already have evaluated the switch.

### First core publication

The new `@mingchuno/agent-workflows-core` package needs npm publishing access and
the same trusted publisher as the CLI package before automated publication can
succeed. If npm requires an initial authenticated publication to create the
package, perform that bootstrap from the intended release's tested core tarball,
then configure trusted publishing. Do not generate a different tarball for the
same version. The pipeline can resume and compare its integrity.

## Verification and recovery

The publishing job runs `pnpm verify` and `pnpm pack:smoke` at the release commit.
The smoke test first installs only the core tarball in a temporary consumer,
checks SDK imports, TypeScript resolution, absence of UI dependencies and isolated
database migrations, then installs the CLI tarball and checks its exact core
dependency, executable and bundled browser assets. It needs registry access and
the [development test prerequisites](../README.md#development-and-review).
Neither command invokes paid agents or writes to real hosting providers.

Publishing checks the tag, release SHA, matching package versions and both tested
tarball integrities. It checks both registry versions before publishing core,
then CLI, using those same tarballs. npm cannot publish the pair atomically; a CLI
failure may leave core published until the retry completes. Release runs are
serialized and never cancelled by newer pushes.

After a publishing failure, choose **Re-run failed jobs** on that Actions run to
retain the release outputs and commit. An existing npm version is skipped only
when its integrity matches; differing contents require a new version. Re-running
the whole workflow or dispatching a new run may find no new release and skip
publishing. If Release Please failed after creating a tag, inspect the existing
release before recovering; never overwrite a published version or delete a
release tag to retry.
