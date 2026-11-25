import { readFileSync } from "node:fs";
import * as path from "node:path";

import { verify } from "sigstore";
import { describe, expect, it } from "vitest";

import { readTagRef, SAW_RELEASE_SIGNER, verifyProvenance, verifyTag, type VerifyBundle } from "../../src/core/install/provenance";

const fixture = (name: string) => readFileSync(path.join(__dirname, "../fixtures/saw-0.17.5", name));
const signers = (JSON.parse(readFileSync("package.json", "utf8")) as { saw: { signers: string[] } }).saw.signers;
const version = "0.17.5";
const commit = "91cd5ee621fd4d887a1c0076e7efcc133820fb07";
const bundle = fixture("stayawakebot-0.17.5.provenance.sigstore.json");
const accepted: VerifyBundle = async () => undefined;
const sigstore: VerifyBundle = async (raw, identity) => {
  await verify(raw as Parameters<typeof verify>[0], identity);
};

describe("saw's signed release tag", () => {
  it("is signed by the pinned key and names the release commit", () => {
    expect(readTagRef(fixture("ref.json").toString())).toBe("48483b28cdd69003a41f7687b14dca0caafefd05");
    expect(verifyTag(fixture("tag.json").toString(), version, signers)).toEqual({ kind: "verified", commit });
  });

  it("is refused when another key signed it, it is another release's, or it was changed", () => {
    const tag = fixture("tag.json").toString();
    const otherKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINTCaW9JunFUFgoIl6gRMUo0w82syQJwXBIC5RMgUt36";
    expect(verifyTag(tag, version, [otherKey])).toMatchObject({ kind: "failed" });
    expect(verifyTag(tag, "0.17.4", signers)).toMatchObject({ kind: "failed" });
    expect(verifyTag(tag.replaceAll(commit, "f".repeat(40)), version, signers)).toMatchObject({ kind: "failed" });
    expect(readTagRef(JSON.stringify({ object: { type: "commit", sha: commit } }))).toBeUndefined();
  });
});

describe("saw's build provenance", () => {
  it("names saw's release workflow, repository, trigger, runner and commit, and every release file", async () => {
    const checked = await verifyProvenance(bundle, version, commit, accepted);
    expect(checked.kind).toBe("verified");
    const subjects = checked.kind === "verified" ? checked.subjects : new Map();
    expect(subjects.get("stayawakebot-0.17.5-py3-none-manylinux_2_28_x86_64.whl")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is refused for another repository, trigger, runner, issuer or commit", async () => {
    const cases: Array<[typeof SAW_RELEASE_SIGNER, string, string]> = [
      [{ ...SAW_RELEASE_SIGNER, repositoryId: "1" }, commit, "repositoryId"],
      [{ ...SAW_RELEASE_SIGNER, ownerId: "1" }, commit, "ownerId"],
      [{ ...SAW_RELEASE_SIGNER, trigger: "workflow_dispatch" }, commit, "trigger"],
      [{ ...SAW_RELEASE_SIGNER, runner: "self-hosted" }, commit, "runner"],
      [{ ...SAW_RELEASE_SIGNER, issuer: "https://example.invalid" }, commit, "issuer"],
      [SAW_RELEASE_SIGNER, "f".repeat(40), "commit"],
    ];
    for (const [signer, expected, field] of cases) {
      const checked = await verifyProvenance(bundle, version, expected, accepted, signer);
      expect(checked.kind === "failed" && checked.detail, field).toContain(`names ${field}`);
    }
  });

  it("is refused when the bundle's signature does not verify", async () => {
    const checked = await verifyProvenance(bundle, version, commit, async () => {
      throw new Error("bad signature");
    });
    expect(checked.kind === "failed" && checked.detail).toContain("not signed by saw's release workflow");
  });

  it("is refused when the bundle is relabelled to carry a certificate Sigstore does not check", async () => {
    const real = JSON.parse(bundle.toString()) as { verificationMaterial: { certificate: { rawBytes: string } } };
    const relabelled = {
      ...real,
      mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.2",
      verificationMaterial: { ...real.verificationMaterial, x509CertificateChain: { certificates: [real.verificationMaterial.certificate] } },
    };
    const checked = await verifyProvenance(Buffer.from(JSON.stringify(relabelled)), version, commit, accepted);
    expect(checked.kind === "failed" && checked.detail).toContain("v0.3 bundle with one certificate");
  });

  it("verifies against Sigstore's public trust root, and only for saw's release workflow", async () => {
    expect((await verifyProvenance(bundle, version, commit, sigstore)).kind).toBe("verified");
    const otherWorkflow = { ...SAW_RELEASE_SIGNER, workflow: "https://github.com/Ndevu12/stayAwakeBot/.github/workflows/other.yml" };
    expect((await verifyProvenance(bundle, version, commit, sigstore, otherWorkflow)).kind).toBe("failed");
    expect((await verifyProvenance(bundle, "0.17", commit, sigstore)).kind).toBe("failed");
  }, 60_000);
});
