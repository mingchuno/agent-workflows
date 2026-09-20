import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const packageName = "@mingchuno/agent-workflows";
const artifactDirectory = resolve(".artifacts");
const artifactRecord = join(artifactDirectory, "release.json");

export function npm(args, options = {}) {
  return execFileSync(
    process.execPath,
    [resolve("node_modules/npm/bin/npm-cli.js"), ...args],
    { encoding: "utf8", ...options },
  );
}

export async function packArtifact() {
  await rm(artifactDirectory, { recursive: true, force: true });
  await mkdir(artifactDirectory, { recursive: true });
  const packed = JSON.parse(
    npm([
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      artifactDirectory,
    ]),
  )[packageName];
  return { ...packed, tarball: join(artifactDirectory, packed.filename) };
}

// Record only after the installed tarball passes every smoke check.
export async function recordArtifact(artifact) {
  await writeFile(artifactRecord, JSON.stringify(artifact));
}

export async function readArtifact() {
  const artifact = JSON.parse(await readFile(artifactRecord, "utf8"));
  const integrity =
    "sha512-" +
    createHash("sha512")
      .update(await readFile(artifact.tarball))
      .digest("base64");
  if (integrity !== artifact.integrity)
    throw new Error("Tested tarball integrity changed; run pack:smoke again.");
  return artifact;
}

export function assertRelease(release, artifact, checkout) {
  if (
    !/^[a-f0-9]{40}$/.test(release.sha ?? "") ||
    !/^\d+\.\d+\.\d+$/.test(release.version ?? "") ||
    release.tag !== `v${release.version}` ||
    artifact.name !== packageName ||
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
