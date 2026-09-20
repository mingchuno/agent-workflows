# Releases

One public npm package, `@mingchuno/agent-workflows`, contains the SDK and
`agent-workflows` CLI/TUI. Release Please opens a version/changelog PR from
Conventional Commits on `main`. Review and merge that PR to create its GitHub
release and publish to npm when enabled. The first release is `0.1.0`; fixes
bump patch, features bump minor, and breaking changes bump minor before 1.0.

## GitHub setup

- Add this repository to the existing release GitHub App installation. It needs
  Contents, Pull requests and Issues read/write. Store `RELEASE_APP_ID` and
  `RELEASE_APP_PRIVATE_KEY` as repository Actions secrets. Tokens are scoped to
  this repository; no webhook server is needed. App-created release PRs trigger CI.
- Enable squash merging with the PR title and description as the commit message.
  Protect `main` with the `check` and `commitlint` checks after their first run.
  Preserve `!` or `BREAKING CHANGE:` when squashing breaking changes.
- Create the `npm` environment with deployment branches restricted to `main`.
  Required reviewers are optional: merging the release PR is the normal release
  decision; environment reviewers would add a second publishing approval.
- Leave the repository variable `NPM_PUBLISH_ENABLED` unset until npm setup is
  complete. Setting it to `true` enables subsequent automatic publications.

## First publication and npm setup

The maintainer must control the `@mingchuno` npm scope and have account 2FA.
The package must exist before configuring its trusted publisher.

1. Merge the implementation, let Release Please open its first release PR, then
   review and merge the proposed `0.1.0` release. Keep automated publishing disabled.
2. In a clean checkout of tag `v0.1.0`, install the pinned tools and dependencies,
   then verify and test the package:

   ```sh
   mise trust
   mise install
   mise exec -- pnpm install --frozen-lockfile
   mise exec -- pnpm verify
   mise exec -- pnpm pack:smoke
   ```

   The smoke test leaves `.artifacts/mingchuno-agent-workflows-0.1.0.tgz`.
   Authenticate interactively and publish that tested tarball:

   ```sh
   mise exec -- pnpm exec npm login --registry=https://registry.npmjs.org/
   mise exec -- pnpm exec npm publish .artifacts/mingchuno-agent-workflows-0.1.0.tgz --access public --ignore-scripts --registry=https://registry.npmjs.org/
   ```

3. In the npm package settings, add a GitHub Actions trusted publisher:

   | Field | Value |
   | --- | --- |
   | Owner | `mingchuno` |
   | Repository | `agent-workflows` |
   | Workflow filename | `release.yml` |
   | Environment | `npm` |
   | Publication permission | Allow direct `npm publish` |

4. Set GitHub repository variable `NPM_PUBLISH_ENABLED=true`. The next releasable
   change exercises OIDC; the manual first publication does not verify it.

The GitHub App manages releases; npm OIDC authenticates publication independently.
No `NPM_TOKEN` is required. The publishing job uses a GitHub-hosted runner,
`id-token: write`, and pinned npm 12. Public repository/package visibility enables
automatic provenance. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

## Verification and recovery

`pnpm verify` runs type checking, linting, release guard tests and the existing
PostgreSQL-backed application tests. `pnpm pack:smoke` additionally needs registry
access: it installs the tarball in a temporary consumer, checks SDK imports and
TypeScript resolution, runs the CLI, and applies migrations to an isolated database.
Both commands use disposable local PostgreSQL or `TEST_DATABASE_URL`; its role must
be able to create test databases. Neither invokes paid agents or real hosting writes.

Publishing checks the tag, release SHA, package version and tested tarball integrity.
It publishes the same tarball that passed the smoke test. Release runs are serialized
and never cancelled by newer pushes.

After a publishing failure, choose **Re-run failed jobs** on that Actions run to
retain the release outputs and commit. An existing npm version is skipped only when
its integrity matches; differing contents require a new version. Re-running the
whole workflow or dispatching a new run may find no new release and skip publishing.
If Release Please failed after creating a tag, inspect the existing release before
recovering; never overwrite a published version or delete a release tag to retry.

To pause future publishing, unset `NPM_PUBLISH_ENABLED` or set it to `false`.
Inspect active runs separately: they may already have evaluated the switch.
