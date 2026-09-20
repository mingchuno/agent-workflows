# Releases

One public npm package, `@mingchuno/agent-workflows`, contains the SDK and
`agent-workflows` CLI/TUI. Release Please opens a version/changelog PR from
Conventional Commits on `main`. Merging that PR creates a GitHub release and,
when `NPM_PUBLISH_ENABLED=true`, publishes to npm. Fixes bump patch, features
bump minor, and breaking changes bump minor before 1.0.

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
  to publish directly. It authenticates independently of the GitHub App via
  OIDC; no `NPM_TOKEN` is required. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
- The repository variable `NPM_PUBLISH_ENABLED=true` enables publication.
  Unset it or set it to `false` to pause future publishing. Inspect active runs
  separately: they may already have evaluated the switch.

## Verification and recovery

The publishing job runs `pnpm verify` and `pnpm pack:smoke` at the release commit.
The smoke test installs the tarball in a temporary consumer, checks SDK imports
and TypeScript resolution, runs the CLI, and applies migrations to an isolated
database. It needs registry access and the [development test prerequisites](../README.md#development-and-review).
Neither command invokes paid agents or writes to real hosting providers.

Publishing checks the tag, release SHA, package version and tested tarball
integrity, then publishes that same tarball. Release runs are serialized and
never cancelled by newer pushes.

After a publishing failure, choose **Re-run failed jobs** on that Actions run to
retain the release outputs and commit. An existing npm version is skipped only
when its integrity matches; differing contents require a new version. Re-running
the whole workflow or dispatching a new run may find no new release and skip
publishing. If Release Please failed after creating a tag, inspect the existing
release before recovering; never overwrite a published version or delete a
release tag to retry.
