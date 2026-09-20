import { execFileSync } from "node:child_process";
import {
  assertRelease,
  lookupPublished,
  npm,
  publishArtifact,
  readArtifact,
} from "./release-package.mjs";

if (
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.GITHUB_REPOSITORY !== "mingchuno/agent-workflows" ||
  process.env.GITHUB_REF !== "refs/heads/main" ||
  !process.env.ACTIONS_ID_TOKEN_REQUEST_URL
) {
  throw new Error(
    "Publishing requires the upstream main branch GitHub Actions OIDC environment.",
  );
}
const release = {
  sha: process.env.RELEASE_SHA,
  tag: process.env.RELEASE_TAG,
  version: process.env.RELEASE_VERSION,
};
if (!/^v\d+\.\d+\.\d+$/.test(release.tag ?? ""))
  throw new Error("Expected a stable release tag, such as v0.1.0.");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const artifact = await readArtifact();
assertRelease(release, artifact, {
  head: git("rev-parse", "HEAD"),
  tagged: git("rev-parse", `refs/tags/${release.tag}^{commit}`),
});
if (git("status", "--porcelain", "--untracked-files=no"))
  throw new Error(
    "Tracked files changed after checkout; refusing publication.",
  );
await publishArtifact(artifact, {
  lookup: lookupPublished,
  publish: (tarball) =>
    npm(
      [
        "publish",
        tarball,
        "--access",
        "public",
        "--tag",
        "latest",
        "--ignore-scripts",
        "--registry",
        "https://registry.npmjs.org/",
      ],
      { stdio: "inherit" },
    ),
});
