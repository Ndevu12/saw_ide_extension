import { manifestName, readManifest, wheelFor, type Machine, type ReleaseManifest } from "./manifest";
import { provenanceName, readTagRef, tagObjectUrl, tagRefUrl, verifyProvenance, verifyTag, type VerifyBundle } from "./provenance";
import { sha256, type SawRelease } from "./release";
import type { Dependencies } from "./update";

export type Fetch = (url: string) => Promise<Uint8Array | undefined>;

export interface DownloadDeps {
  fetch: Fetch;
  signers: readonly string[];
  verifyBundle: VerifyBundle;
  machine: Machine;
}

export type Verified =
  | { kind: "verified"; manifest: ReleaseManifest; attested: (name: string) => Promise<Uint8Array | undefined> }
  | { kind: "failed"; detail: string };

export type Downloaded =
  | { kind: "verified"; wheelName: string; wheel: Uint8Array; dependencies: Dependencies }
  | { kind: "failed"; detail: string };

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");

export async function verifyRelease(release: SawRelease, deps: DownloadDeps): Promise<Verified> {
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
  const attested = async (name: string) => {
    const expected = provenance.subjects.get(name);
    const file = expected ? await download(name) : undefined;
    return file && sha256(file) === expected ? file : undefined;
  };
  const manifestFile = await attested(manifestName(release.version));
  if (!manifestFile) {
    return { kind: "failed", detail: "its platforms manifest is missing or does not match its attested hash." };
  }
  const manifest = readManifest(text(manifestFile), release.version);
  return typeof manifest === "string" ? { kind: "failed", detail: manifest } : { kind: "verified", manifest, attested };
}

export async function downloadRelease(release: SawRelease, deps: DownloadDeps): Promise<Downloaded> {
  const verified = await verifyRelease(release, deps);
  if (verified.kind === "failed") {
    return verified;
  }
  const wheel = wheelFor(verified.manifest, deps.machine);
  if (typeof wheel === "string") {
    return { kind: "failed", detail: wheel };
  }
  const wheelFile = await verified.attested(wheel.file);
  if (!wheelFile || sha256(wheelFile) !== wheel.sha256) {
    return { kind: "failed", detail: "its package does not match its attested hash." };
  }
  const lock = await verified.attested(verified.manifest.requirementsLock);
  if (!lock) {
    return { kind: "failed", detail: "its dependency lock is missing or does not match its attested hash." };
  }
  return { kind: "verified", wheelName: wheel.file, wheel: wheelFile, dependencies: { lock: text(lock) } };
}
