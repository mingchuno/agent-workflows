import assert from "node:assert/strict";
import { test } from "node:test";
import { assertRelease, publishArtifact } from "./release-package.mjs";

const release = { sha: "a".repeat(40), tag: "v0.1.0", version: "0.1.0" };
const artifact = {
  name: "@mingchuno/agent-workflows",
  version: "0.1.0",
  integrity: "sha512-fixture",
  tarball: "/tmp/package.tgz",
};

test("release identity binds the package to its exact tag and commit", () => {
  const checkout = { head: release.sha, tagged: release.sha };
  assertRelease(release, artifact, checkout);
  for (const changed of [
    { ...artifact, name: "another-package" },
    { ...artifact, version: "0.2.0" },
  ])
    assert.throws(() => assertRelease(release, changed, checkout));
  assert.throws(() =>
    assertRelease({ ...release, tag: "v0.2.0" }, artifact, checkout),
  );
  assert.throws(() =>
    assertRelease(release, artifact, { ...checkout, head: "b".repeat(40) }),
  );
  assert.throws(() =>
    assertRelease(release, artifact, { ...checkout, tagged: "b".repeat(40) }),
  );
  assert.throws(() =>
    assertRelease({ ...release, sha: "" }, artifact, checkout),
  );
});

test("a missing registry version is published once", async () => {
  const published = [];
  await publishArtifact(artifact, {
    lookup: async () => null,
    publish: async (tarball) => published.push(tarball),
  });
  assert.deepEqual(published, [artifact.tarball]);
});

test("a retry skips only an identical published tarball", async () => {
  const publish = () => assert.fail("must not republish an existing version");
  await publishArtifact(artifact, {
    lookup: async () => artifact.integrity,
    publish,
  });
  await assert.rejects(
    publishArtifact(artifact, {
      lookup: async () => "sha512-different",
      publish,
    }),
    /integrity/,
  );
});

test("registry failures abort publication instead of treating the version as missing", async () => {
  await assert.rejects(
    publishArtifact(artifact, {
      lookup: async () => {
        throw new Error("registry unavailable");
      },
      publish: () => assert.fail("must not publish after a lookup failure"),
    }),
    /registry unavailable/,
  );
});
