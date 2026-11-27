import { readFileSync } from "node:fs";
import * as path from "node:path";

import { verify } from "sigstore";
import { describe, expect, it } from "vitest";

import { verifyRelease } from "../../src/core/install/download";
import { manifestName, readManifest, wheelFor, type ReleaseManifest } from "../../src/core/install/manifest";
import { provenanceName, tagObjectUrl, tagRefUrl } from "../../src/core/install/provenance";
import type { SawRelease } from "../../src/core/install/release";

const version = "0.18.0";
const fixture = (name: string) => readFileSync(path.join(__dirname, "../fixtures/saw-0.18.0", name));
const signers = (JSON.parse(readFileSync("package.json", "utf8")) as { saw: { signers: string[] } }).saw.signers;

function manifest(): ReleaseManifest {
  const read = readManifest(fixture(manifestName(version)).toString(), version);
  if (typeof read === "string") {
    throw new Error(read);
  }
  return read;
}

describe("saw's platforms manifest", () => {
  it("reads the 0.18.0 manifest", () => {
    const read = manifest();
    expect(read).toMatchObject({ contract: 1, security: false, requirementsLock: `stayawakebot-${version}.requirements.lock` });
    expect(read.wheels.map((w) => `${w.os}/${w.arch}`)).toEqual(["macos/arm64", "macos/x86_64", "linux/arm64", "linux/x86_64", "windows/x86_64"]);
  });

  it("refuses a newer contract, another release, or a document that is not one", () => {
    const text = fixture(manifestName(version)).toString();
    expect(readManifest(text.replace('"contract": 1', '"contract": 2'), version)).toContain("contract 2");
    expect(readManifest(text, "0.17.9")).toContain("not for this release");
    expect(readManifest("null", version)).toContain("cannot be read");
  });

  it("chooses the wheel this machine can run, and says why when there is none", () => {
    const read = manifest();
    expect(wheelFor(read, { os: "linux", arch: "x86_64", glibc: "2.39" })).toMatchObject({ file: `stayawakebot-${version}-py3-none-manylinux_2_28_x86_64.whl` });
    expect(wheelFor(read, { os: "windows", arch: "x86_64" })).toMatchObject({ file: `stayawakebot-${version}-py3-none-win_amd64.whl` });
    expect(wheelFor(read, { os: "macos", arch: "arm64", macos: "15" })).toMatchObject({ os: "macos", arch: "arm64" });
    expect(wheelFor(read, { os: "linux", arch: "x86_64", glibc: "2.17" })).toContain("needs glibc 2.28");
    expect(wheelFor(read, { os: "linux", arch: "x86_64" })).toContain("needs glibc");
    expect(wheelFor(read, { os: "macos", arch: "arm64", macos: "10.15" })).toContain("needs macOS");
    expect(wheelFor(read, { os: "windows", arch: "arm64" })).toContain("no package for windows arm64");
  });
});

describe("saw 0.18.0 as published", () => {
  it("passes every check: signed tag, Sigstore provenance, release workflow, attested manifest", async () => {
    const base = `https://github.com/Ndevu12/stayAwakeBot/releases/download/v${version}/`;
    const files: Record<string, Buffer> = {
      [provenanceName(version)]: fixture(provenanceName(version)),
      [manifestName(version)]: fixture(manifestName(version)),
    };
    const release: SawRelease = { version, publishedAt: 0, notesUrl: "", assets: Object.keys(files).map((name) => ({ name, url: base + name })) };
    const tagSha = (JSON.parse(fixture("ref.json").toString()) as { object: { sha: string } }).object.sha;
    const api: Record<string, Buffer> = { [tagRefUrl(version)]: fixture("ref.json"), [tagObjectUrl(tagSha)]: fixture("tag.json") };
    const fetch = async (url: string) => {
      const found = api[url] ?? files[url.slice(base.length)];
      return found ? new Uint8Array(found) : undefined;
    };
    const verifyBundle = async (bundle: unknown, identity: { certificateIssuer: string; certificateIdentityURI: string }) => {
      await verify(bundle as Parameters<typeof verify>[0], identity);
    };
    const verified = await verifyRelease(release, { fetch, signers, verifyBundle, machine: { os: "linux", arch: "x86_64", glibc: "2.39" } });
    expect(verified.kind === "failed" ? verified.detail : verified.manifest.requirementsLock).toBe(`stayawakebot-${version}.requirements.lock`);
  }, 60_000);
});
