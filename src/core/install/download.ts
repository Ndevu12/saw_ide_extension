import { provenanceName, readTagRef, tagObjectUrl, tagRefUrl, verifyProvenance, verifyTag, type VerifyBundle } from "./provenance";
import { sbomPins, sha256, wheelFor, type SawRelease } from "./release";
import type { Dependencies } from "./update";

export type Fetch = (url: string) => Promise<Uint8Array | undefined>;

export interface DownloadDeps {
  fetch: Fetch;
  signers: readonly string[];
  verifyBundle: VerifyBundle;
  platform: NodeJS.Platform;
  arch: string;
}

export type Downloaded =
  | { kind: "verified"; wheelName: string; wheel: Uint8Array; dependencies: Dependencies }
  | { kind: "failed"; detail: string };

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");

/** The wheel for this machine and what pins its dependencies, each checked against the release's attested build provenance. */
export async function downloadRelease(release: SawRelease, deps: DownloadDeps): Promise<Downloaded> {
  const download = (name: string) => {
    const asset = release.assets.find((a) => a.name === name);
    return asset ? deps.fetch(asset.url) : Promise.resolve(undefined);
  };
  const ref = await deps.fetch(tagRefUrl(release.version));
  const tagSha = ref && readTagRef(text(ref));
  const tagObject = tagSha ? await deps.fetch(tagObjectUrl(tagSha)) : undefined;
  if (!tagObject) {
    return { kind: "failed", detail: `its tag v${release.version} could not be read.` };
  }
  const tag = verifyTag(text(tagObject), release.version, deps.signers);
  if (tag.kind === "failed") {
    return tag;
  }
  const bundle = await download(provenanceName(release.version));
  if (!bundle) {
    return { kind: "failed", detail: "its build provenance is missing." };
  }
  const provenance = await verifyProvenance(bundle, release.version, tag.commit, deps.verifyBundle);
  if (provenance.kind === "failed") {
    return provenance;
  }
  const hashes = provenance.subjects;
  const hashed = async (name: string) => {
    const file = await download(name);
    return file && sha256(file) === hashes.get(name) ? file : undefined;
  };

  const wheelName = wheelFor(deps.platform, deps.arch, release.version);
  if (!wheelName || !hashes.has(wheelName)) {
    return { kind: "failed", detail: `it has no attested package for ${deps.platform} ${deps.arch}.` };
  }
  const wheel = await hashed(wheelName);
  if (!wheel) {
    return { kind: "failed", detail: "its package does not match its attested hash." };
  }

  const lockName = [...hashes.keys()].find((name) => name.endsWith("requirements.lock"));
  if (lockName) {
    const lock = await hashed(lockName);
    return lock
      ? { kind: "verified", wheelName, wheel, dependencies: { lock: text(lock) } }
      : { kind: "failed", detail: "its dependency lock does not match its attested hash." };
  }
  const sbom = await hashed(`stayawakebot-${release.version}.sbom.cdx.json`);
  const pins = sbom && sbomPins(text(sbom));
  return pins
    ? { kind: "verified", wheelName, wheel, dependencies: { pins } }
    : { kind: "failed", detail: "it has no attested list of its dependencies." };
}
