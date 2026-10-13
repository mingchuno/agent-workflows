import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const packageName = "@mingchuno/agent-workflows";
export const corePackageName = "@mingchuno/agent-workflows-core";
export const releasePackages = [
  { name: corePackageName, directory: "packages/core" },
  { name: packageName, directory: "packages/cli" },
];

export function assertWorkspaceVersions(root, core, cli) {
  if (
    !root.private ||
    core.name !== corePackageName ||
    cli.name !== packageName
  )
    throw new Error(
      "Expected a private root and the two public workspace packages.",
    );
  if (root.version !== core.version || root.version !== cli.version)
    throw new Error("Root, core and CLI versions must match.");
  if (cli.dependencies?.[corePackageName] !== "workspace:*")
    throw new Error(
      "CLI must depend on core through workspace:* for an exact published version.",
    );
}
const artifactDirectory = resolve(".artifacts");
const artifactRecord = join(artifactDirectory, "release.json");

export function npm(args, options = {}) {
  return execFileSync(
    process.execPath,
    [resolve("node_modules/npm/bin/npm-cli.js"), ...args],
    { encoding: "utf8", ...options },
  );
}

export async function packArtifacts() {
  await rm(artifactDirectory, { recursive: true, force: true });
  await mkdir(artifactDirectory, { recursive: true });
  const artifacts = [];
  for (const { name, directory } of releasePackages) {
    execFileSync("pnpm", ["pack", "--pack-destination", artifactDirectory], {
      cwd: resolve(directory),
      stdio: "inherit",
    });
    const manifest = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    );
    const filename = `${name.replace("@", "").replace("/", "-")}-${manifest.version}.tgz`;
    const tarball = join(artifactDirectory, filename);
    const integrity =
      "sha512-" +
      createHash("sha512")
        .update(await readFile(tarball))
        .digest("base64");
    const files = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((path) => ({ path: path.replace(/^package\//, "") }));
    artifacts.push({
      name,
      version: manifest.version,
      integrity,
      tarball,
      files,
    });
  }
  return artifacts;
}

// Record only after the installed tarball passes every smoke check.
export async function recordArtifacts(artifacts) {
  await writeFile(artifactRecord, JSON.stringify(artifacts));
}

export async function readArtifacts() {
  const artifacts = JSON.parse(await readFile(artifactRecord, "utf8"));
  assertArtifactPair(artifacts);
  for (const artifact of artifacts) {
    const integrity =
      "sha512-" +
      createHash("sha512")
        .update(await readFile(artifact.tarball))
        .digest("base64");
    if (integrity !== artifact.integrity)
      throw new Error(
        "Tested tarball integrity changed; run pack:smoke again.",
      );
  }
  return artifacts;
}

export function assertArtifactPair(artifacts) {
  if (
    artifacts.length !== 2 ||
    artifacts[0].name !== corePackageName ||
    artifacts[1].name !== packageName ||
    artifacts[0].version !== artifacts[1].version
  )
    throw new Error(
      "Release requires core and CLI artifacts with matching versions, in that order.",
    );
}

export function assertRelease(release, artifact, checkout) {
  if (
    !/^[a-f0-9]{40}$/.test(release.sha ?? "") ||
    !/^\d+\.\d+\.\d+$/.test(release.version ?? "") ||
    release.tag !== `v${release.version}` ||
    !releasePackages.some((entry) => entry.name === artifact.name) ||
    artifact.version !== release.version ||
    checkout.head !== release.sha ||
    checkout.tagged !== release.sha
  ) {
    throw new Error(
      "Package, release version, tag and checkout must identify the same release.",
    );
  }
}

export async function lookupPublished(artifact) {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(artifact.name)}/${encodeURIComponent(artifact.version)}`,
    { signal: AbortSignal.timeout(30000) },
  );
  if (response.status === 404) return null;
  if (!response.ok)
    throw new Error(`npm registry lookup failed: ${response.status}`);
  const metadata = await response.json();
  if (!metadata.dist?.integrity)
    throw new Error("Published package has no integrity to compare.");
  return metadata.dist.integrity;
}

export async function publishArtifact(artifact, registry) {
  const integrity = await registry.lookup(artifact);
  if (integrity === artifact.integrity) {
    console.log(
      `${artifact.name}@${artifact.version} already published with matching integrity.`,
    );
    return;
  }
  if (integrity !== null)
    throw new Error(
      "Published version has different integrity; a new version is required.",
    );
  await registry.publish(artifact.tarball);
}

export async function publishArtifacts(artifacts, registry) {
  assertArtifactPair(artifacts);
  // Check both identities before creating either registry version.
  const integrities = new Map();
  for (const artifact of artifacts) {
    const integrity = await registry.lookup(artifact);
    if (integrity !== null && integrity !== artifact.integrity)
      throw new Error(
        "Published version has different integrity; a new version is required.",
      );
    integrities.set(artifact.name, integrity);
  }
  for (const artifact of artifacts)
    await publishArtifact(artifact, {
      lookup: async (candidate) => integrities.get(candidate.name),
      publish: registry.publish,
    });
}
