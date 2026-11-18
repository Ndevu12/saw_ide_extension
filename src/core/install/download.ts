import { readSums, sbomPins, sha256, wheelFor, type SawRelease } from "./release";
import { verifySshSignature } from "./sshsig";
import type { Dependencies } from "./update";

export type Fetch = (url: string) => Promise<Uint8Array | undefined>;

export interface DownloadDeps {
  fetch: Fetch;
  signers: readonly string[];
  platform: NodeJS.Platform;
  arch: string;
}

export type Downloaded =
  | { kind: "verified"; wheelName: string; wheel: Uint8Array; dependencies: Dependencies }
  | { kind: "failed"; detail: string };

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");

/** The wheel for this machine and what pins its dependencies, each checked against the release's signed SHA256SUMS. */
export async function downloadRelease(release: SawRelease, deps: DownloadDeps): Promise<Downloaded> {
  const download = (name: string) => {
    const asset = release.assets.find((a) => a.name === name);
    return asset ? deps.fetch(asset.url) : Promise.resolve(undefined);
  };
  const signed = async (name: string) => {
    const [file, signature] = await Promise.all([download(name), download(`${name}.sig`)]);
    return file && signature && verifySshSignature(file, text(signature), deps.signers) ? file : undefined;
  };

  const sums = await signed("SHA256SUMS");
  if (!sums) {
    return { kind: "failed", detail: "its SHA256SUMS is missing or not signed by saw's release key." };
  }
  const hashes = readSums(text(sums));
  const hashed = async (name: string) => {
    const file = await download(name);
    return file && sha256(file) === hashes.get(name) ? file : undefined;
  };

  const wheelName = wheelFor(deps.platform, deps.arch, release.version);
  if (!wheelName || !hashes.has(wheelName)) {
    return { kind: "failed", detail: `it has no signed package for ${deps.platform} ${deps.arch}.` };
  }
  const wheel = await hashed(wheelName);
  if (!wheel) {
    return { kind: "failed", detail: "its package does not match the signed hash." };
  }

  const lockName = [...hashes.keys()].find((name) => name.endsWith("requirements.lock"));
  if (lockName) {
    const lock = await hashed(lockName);
    return lock
      ? { kind: "verified", wheelName, wheel, dependencies: { lock: text(lock) } }
      : { kind: "failed", detail: "its dependency lock does not match the signed hash." };
  }
  const sbom = await signed(`stayawakebot-${release.version}.sbom.cdx.json`);
  const pins = sbom && sbomPins(text(sbom));
  return pins
    ? { kind: "verified", wheelName, wheel, dependencies: { pins } }
    : { kind: "failed", detail: "it has no signed list of its dependencies." };
}
