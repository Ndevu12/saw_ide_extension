import { X509Certificate as NodeX509Certificate } from "node:crypto";

import { X509Certificate } from "@sigstore/core";

import { verifySshSignature } from "./sshsig";

export interface ReleaseSigner {
  issuer: string;
  workflow: string;
  repositoryId: string;
  ownerId: string;
  trigger: string;
  runner: string;
}

export const SAW_RELEASE_SIGNER: ReleaseSigner = {
  issuer: "https://token.actions.githubusercontent.com",
  workflow: "https://github.com/Ndevu12/stayAwakeBot/.github/workflows/release.yml",
  repositoryId: "1206179212",
  ownerId: "140616733",
  trigger: "push",
  runner: "github-hosted",
};

const OID = {
  issuer: "1.3.6.1.4.1.57264.1.8",
  runner: "1.3.6.1.4.1.57264.1.11",
  commit: "1.3.6.1.4.1.57264.1.13",
  repositoryId: "1.3.6.1.4.1.57264.1.15",
  ownerId: "1.3.6.1.4.1.57264.1.17",
  trigger: "1.3.6.1.4.1.57264.1.20",
} as const;

const SLSA_PROVENANCE = "https://slsa.dev/provenance/v1";
const BUNDLE_V03 = "application/vnd.dev.sigstore.bundle.v0.3+json";
const IN_TOTO = "application/vnd.in-toto+json";

export type VerifyBundle = (bundle: unknown, identity: { certificateIssuer: string; certificateIdentityURI: string }) => Promise<void>;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type Checked<T> = ({ kind: "verified" } & T) | { kind: "failed"; detail: string };

export function provenanceName(version: string): string {
  return `stayawakebot-${version}.provenance.sigstore.json`;
}

export function tagRefUrl(version: string): string {
  return `https://api.github.com/repos/Ndevu12/stayAwakeBot/git/ref/tags/v${version}`;
}

export function tagObjectUrl(sha: string): string {
  return `https://api.github.com/repos/Ndevu12/stayAwakeBot/git/tags/${sha}`;
}

export function readTagRef(text: string): string | undefined {
  try {
    const object = (JSON.parse(text) as { object?: { type?: unknown; sha?: unknown } }).object;
    return object?.type === "tag" && typeof object.sha === "string" && /^[0-9a-f]{40}$/.test(object.sha) ? object.sha : undefined;
  } catch {
    return undefined;
  }
}

export function verifyTag(text: string, version: string, signers: readonly string[]): Checked<{ commit: string }> {
  let verification: { payload?: unknown; signature?: unknown } | undefined;
  try {
    verification = (JSON.parse(text) as { verification?: { payload?: unknown; signature?: unknown } }).verification;
  } catch {
    verification = undefined;
  }
  const payload = verification?.payload;
  const signature = verification?.signature;
  if (typeof payload !== "string" || typeof signature !== "string") {
    return { kind: "failed", detail: `its tag v${version} is not signed.` };
  }
  if (!verifySshSignature(Buffer.from(payload, "utf8"), signature, signers, "git")) {
    return { kind: "failed", detail: `its tag v${version} is not signed by saw's release key.` };
  }
  const header = payload.split("\n\n", 1)[0]?.split("\n") ?? [];
  const field = (name: string) => header.find((line) => line.startsWith(`${name} `))?.slice(name.length + 1);
  const commit = field("object");
  if (field("tag") !== `v${version}` || field("type") !== "commit" || !commit || !/^[0-9a-f]{40}$/.test(commit)) {
    return { kind: "failed", detail: `its tag v${version} does not name a commit of that release.` };
  }
  return { kind: "verified", commit };
}

function utf8String(der: Buffer): string | undefined {
  if (der.length < 2 || der[0] !== 0x0c) {
    return undefined;
  }
  let length = der[1] ?? 0;
  let start = 2;
  if (length & 0x80) {
    const bytes = length & 0x7f;
    if (bytes < 1 || bytes > 2 || der.length < 2 + bytes) {
      return undefined;
    }
    length = der.readUIntBE(2, bytes);
    start = 2 + bytes;
  }
  return der.length === start + length ? der.subarray(start).toString("utf8") : undefined;
}

function certificateField(certificate: X509Certificate, oid: string): string | undefined {
  const value = certificate.extension(oid)?.value;
  return value ? utf8String(Buffer.from(value)) : undefined;
}

export async function verifyProvenance(bytes: Uint8Array, version: string, commit: string, verifyBundle: VerifyBundle, signer: ReleaseSigner = SAW_RELEASE_SIGNER): Promise<Checked<{ subjects: ReadonlyMap<string, string> }>> {
  let bundle: { mediaType?: unknown; verificationMaterial?: Record<string, unknown> & { certificate?: { rawBytes?: unknown } }; dsseEnvelope?: { payload?: unknown; payloadType?: unknown }; messageSignature?: unknown };
  try {
    bundle = JSON.parse(Buffer.from(bytes).toString("utf8")) as typeof bundle;
  } catch {
    return { kind: "failed", detail: "its build provenance cannot be read." };
  }
  const material = bundle.verificationMaterial;
  if (bundle.mediaType !== BUNDLE_V03 || !material || !material.certificate || "x509CertificateChain" in material || "publicKey" in material || !bundle.dsseEnvelope || "messageSignature" in bundle) {
    return { kind: "failed", detail: "its build provenance is not a Sigstore v0.3 bundle with one certificate." };
  }
  const identity = `${signer.workflow}@refs/tags/v${version}`;
  try {
    await verifyBundle(bundle, { certificateIssuer: signer.issuer, certificateIdentityURI: `^${escapeRegExp(identity)}$` });
  } catch (error) {
    return { kind: "failed", detail: `its build provenance is not signed by saw's release workflow for v${version} (${String(error)}).` };
  }
  const raw = material.certificate.rawBytes;
  let certificate: X509Certificate;
  let subjectAltName: string | undefined;
  try {
    const der = Buffer.from(typeof raw === "string" ? raw : "", "base64");
    certificate = X509Certificate.parse(der);
    subjectAltName = new NodeX509Certificate(der).subjectAltName;
  } catch {
    return { kind: "failed", detail: "its build provenance has no readable certificate." };
  }
  if (subjectAltName !== `URI:${identity}`) {
    return { kind: "failed", detail: `its build provenance names ${subjectAltName ?? "(none)"}, not ${identity}.` };
  }
  const expected: Record<keyof typeof OID, string> = { issuer: signer.issuer, runner: signer.runner, commit, repositoryId: signer.repositoryId, ownerId: signer.ownerId, trigger: signer.trigger };
  for (const name of Object.keys(OID) as (keyof typeof OID)[]) {
    const found = certificateField(certificate, OID[name]);
    if (found !== expected[name]) {
      return { kind: "failed", detail: `its build provenance names ${name} ${found ?? "(none)"}, not ${expected[name]}.` };
    }
  }
  const envelope = bundle.dsseEnvelope;
  if (envelope?.payloadType !== IN_TOTO || typeof envelope.payload !== "string") {
    return { kind: "failed", detail: "its build provenance holds no in-toto statement." };
  }
  let statement: { predicateType?: unknown; subject?: unknown };
  try {
    statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")) as typeof statement;
  } catch {
    return { kind: "failed", detail: "its build provenance statement cannot be read." };
  }
  if (statement.predicateType !== SLSA_PROVENANCE || !Array.isArray(statement.subject)) {
    return { kind: "failed", detail: "its build provenance is not SLSA provenance." };
  }
  const subjects = new Map<string, string>();
  for (const entry of statement.subject as ({ name?: unknown; digest?: { sha256?: unknown } } | null)[]) {
    if (entry && typeof entry.name === "string" && typeof entry.digest?.sha256 === "string" && /^[0-9a-f]{64}$/.test(entry.digest.sha256)) {
      subjects.set(entry.name, entry.digest.sha256);
    }
  }
  return { kind: "verified", subjects };
}
