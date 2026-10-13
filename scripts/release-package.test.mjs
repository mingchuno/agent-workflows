import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertRelease,
  assertWorkspaceVersions,
  publishArtifact,
  publishArtifacts,
} from "./release-package.mjs";

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

const coreArtifact = {
  ...artifact,
  name: "@mingchuno/agent-workflows-core",
  tarball: "/tmp/core.tgz",
};

test("workspace versions must match and the CLI must require its local core", () => {
  const root = { private: true, version: "0.1.0" };
  const core = { name: coreArtifact.name, version: "0.1.0" };
  const cli = {
    name: artifact.name,
    version: "0.1.0",
    dependencies: { [core.name]: "workspace:*" },
  };
  assertWorkspaceVersions(root, core, cli);
  assert.throws(
    () => assertWorkspaceVersions(root, { ...core, version: "0.2.0" }, cli),
    /version/,
  );
  assert.throws(
    () => assertWorkspaceVersions(root, core, { ...cli, version: "0.2.0" }),
    /version/,
  );
  assert.throws(
    () =>
      assertWorkspaceVersions(root, core, {
        ...cli,
        dependencies: { [core.name]: "^0.1.0" },
      }),
    /workspace/,
  );
});

test("paired publication publishes core first and resumes after a CLI failure", async () => {
  const published = new Map();
  const calls = [];
  let failCli = true;
  const registry = {
    lookup: async (candidate) => published.get(candidate.name) ?? null,
    publish: async (tarball) => {
      calls.push(tarball);
      if (tarball === artifact.tarball && failCli)
        throw new Error("CLI publication failed");
      const candidate =
        tarball === coreArtifact.tarball ? coreArtifact : artifact;
      published.set(candidate.name, candidate.integrity);
    },
  };
  await assert.rejects(
    publishArtifacts([coreArtifact, artifact], registry),
    /CLI publication failed/,
  );
  assert.deepEqual(calls, [coreArtifact.tarball, artifact.tarball]);
  failCli = false;
  await publishArtifacts([coreArtifact, artifact], registry);
  assert.deepEqual(calls, [
    coreArtifact.tarball,
    artifact.tarball,
    artifact.tarball,
  ]);
});

test("a core publication failure prevents CLI publication", async () => {
  const calls = [];
  await assert.rejects(
    publishArtifacts([coreArtifact, artifact], {
      lookup: async () => null,
      publish: async (tarball) => {
        calls.push(tarball);
        throw new Error("core publication failed");
      },
    }),
    /core publication failed/,
  );
  assert.deepEqual(calls, [coreArtifact.tarball]);
});

test("an inconsistent artifact pair or conflicting registry version aborts both publications", async () => {
  const registry = {
    lookup: async (candidate) =>
      candidate.name === artifact.name ? "sha512-conflict" : null,
    publish: () => assert.fail("must not publish an inconsistent release"),
  };
  for (const artifacts of [
    [artifact],
    [artifact, coreArtifact],
    [coreArtifact, { ...artifact, version: "0.2.0" }],
    [coreArtifact, artifact],
  ])
    await assert.rejects(publishArtifacts(artifacts, registry));
});
