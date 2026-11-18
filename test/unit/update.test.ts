import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { downloadRelease } from "../../src/core/install/download";
import { chooseUpdate, readRelease, readSums, sbomPins, sha256, UPDATE_WAIT_MS, wheelFor, type SawRelease } from "../../src/core/install/release";
import { verifySshSignature } from "../../src/core/install/sshsig";
import { CLEAN_SAMPLE, INFECTED_SAMPLE, installUpdate, type UpdateDeps } from "../../src/core/install/update";
import type { RunResult } from "../../src/core/run";

const fixture = (name: string) => readFileSync(path.join(__dirname, "../fixtures/saw-0.17.3", name));
const signers = (JSON.parse(readFileSync("package.json", "utf8")) as { saw: { signers: string[] } }).saw.signers;
const DAY = 86_400_000;
const PUBLISHED = Date.parse("2026-11-18T09:45:56Z");

function release(over: Record<string, unknown> = {}) {
  const read = readRelease(JSON.stringify({
    tag_name: "v0.17.3",
    name: "release: 0.17.3",
    published_at: "2026-11-18T09:45:56Z",
    draft: false,
    prerelease: false,
    assets: [{ name: "SHA256SUMS", browser_download_url: "https://github.com/Ndevu12/stayAwakeBot/releases/download/v0.17.3/SHA256SUMS" }],
    ...over,
  }));
  if (!read) {
    throw new Error("the release did not read");
  }
  return read;
}

const context = { current: [0, 17, 2] as const, highest: undefined, now: PUBLISHED + DAY, declined: [] };

describe("saw's signed releases", () => {
  it("accepts SHA256SUMS signed by the pinned key, and nothing else", () => {
    const sums = fixture("SHA256SUMS");
    const sig = fixture("SHA256SUMS.sig").toString();
    expect(verifySshSignature(sums, sig, signers)).toBe(true);
    expect(verifySshSignature(Buffer.concat([sums, Buffer.from("\n")]), sig, signers)).toBe(false);
    expect(verifySshSignature(sums, sig, ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINTCaW9JunFUFgoIl6gRMUo0w82syQJwXBIC5RMgUt36"])).toBe(false);
    expect(verifySshSignature(sums, "not a signature", signers)).toBe(false);
    expect(readSums(sums.toString()).get("stayawakebot-0.17.3-py3-none-manylinux_2_17_x86_64.whl")).toBe("672e4b9a3f76bdbe195e78c28e594158aecf8e0b4320d937b2d0ca048f23ae26");
  });

  it("reads only a published release, and assets from saw's own release downloads", () => {
    expect(release().assets).toHaveLength(1);
    expect(readRelease(JSON.stringify({ tag_name: "v0.17.3", published_at: "2026-11-18T09:45:56Z", prerelease: true, assets: [] }))).toBeUndefined();
    expect(readRelease(JSON.stringify({ tag_name: "v0.17.3", published_at: "2026-11-18T09:45:56Z", draft: true, assets: [] }))).toBeUndefined();
    expect(readRelease(JSON.stringify({ tag_name: "latest", published_at: "2026-11-18T09:45:56Z", assets: [] }))).toBeUndefined();
    expect(release({ assets: [{ name: "SHA256SUMS", browser_download_url: "https://attacker.example/SHA256SUMS" }] }).assets).toEqual([]);
  });

  it("names the wheel for each machine saw builds for", () => {
    expect(wheelFor("linux", "x64", "0.17.3")).toBe("stayawakebot-0.17.3-py3-none-manylinux_2_17_x86_64.whl");
    expect(wheelFor("darwin", "arm64", "0.17.3")).toBe("stayawakebot-0.17.3-py3-none-macosx_11_0_arm64.whl");
    expect(wheelFor("win32", "x64", "0.17.3")).toBeUndefined();
  });

  it("pins dependencies from the SBOM, leaving out saw and pip", () => {
    const sbom = JSON.stringify({ components: [{ name: "aiohttp", version: "3.14.5" }, { name: "pip", version: "26.2.2" }, { name: "stayawakebot", version: "0.17.3" }, { name: "bad name", version: "1" }] });
    expect(sbomPins(sbom)).toEqual(["aiohttp==3.14.5"]);
    expect(sbomPins("{}")).toBeUndefined();
  });

  it("waits 3 days after publishing, unless the release is a security release", () => {
    expect(chooseUpdate(release(), context)).toEqual({ kind: "waiting", dueAt: PUBLISHED + UPDATE_WAIT_MS });
    expect(chooseUpdate(release(), { ...context, now: PUBLISHED + UPDATE_WAIT_MS })).toEqual({ kind: "due", why: "waited" });
    expect(chooseUpdate(release({ name: "release: 0.17.3 (security)" }), context)).toEqual({ kind: "due", why: "security" });
  });

  it("never moves back, below the newest release this machine ran, or to a declined release on its own", () => {
    expect(chooseUpdate(release(), { ...context, current: [0, 17, 3] })).toEqual({ kind: "none" });
    expect(chooseUpdate(release(), { ...context, current: [0, 18, 0] })).toEqual({ kind: "none" });
    expect(chooseUpdate(release(), { ...context, highest: "0.18.0" })).toEqual({ kind: "none" });
    expect(chooseUpdate(release({ name: "security" }), { ...context, declined: ["0.17.3"] })).toEqual({ kind: "waiting", dueAt: Number.POSITIVE_INFINITY });
  });
});

/** Signs like `ssh-keygen -Y sign -n file`, with a key made for the test. */
function testSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const str = (value: Buffer | string) => {
    const data = Buffer.from(value);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, data]);
  };
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x ?? "", "base64url");
  const key = Buffer.concat([str("ssh-ed25519"), str(raw)]);
  return {
    line: `ssh-ed25519 ${key.toString("base64")}`,
    sign: (message: Buffer | string) => {
      const digest = createHash("sha512").update(message).digest();
      const signature = sign(null, Buffer.concat([Buffer.from("SSHSIG"), str("file"), str(""), str("sha512"), str(digest)]), privateKey);
      const version = Buffer.alloc(4);
      version.writeUInt32BE(1);
      const blob = Buffer.concat([Buffer.from("SSHSIG"), version, str(key), str("file"), str(""), str("sha512"), str(Buffer.concat([str("ssh-ed25519"), str(signature)]))]);
      return `-----BEGIN SSH SIGNATURE-----\n${blob.toString("base64")}\n-----END SSH SIGNATURE-----\n`;
    },
  };
}

describe("downloading a release", () => {
  const signer = testSigner();
  const wheelName = "stayawakebot-0.17.3-py3-none-manylinux_2_17_x86_64.whl";
  const sbomName = "stayawakebot-0.17.3.sbom.cdx.json";

  function served(files: Record<string, string>, change: Record<string, string> = {}) {
    const base = "https://github.com/Ndevu12/stayAwakeBot/releases/download/v0.17.3/";
    const sums = Object.entries(files).map(([name, text]) => `${sha256(text)}  ${name}`).join("\n") + "\n";
    const all: Record<string, string> = { ...files, SHA256SUMS: sums, "SHA256SUMS.sig": signer.sign(sums), ...change };
    const rel: SawRelease = { version: "0.17.3", publishedAt: PUBLISHED, security: false, notesUrl: "", assets: Object.keys(all).map((name) => ({ name, url: base + name })) };
    const fetch = async (url: string) => {
      const text = all[url.slice(base.length)];
      return text === undefined ? undefined : new Uint8Array(Buffer.from(text));
    };
    return downloadRelease(rel, { fetch, signers: [signer.line], platform: "linux", arch: "x64" });
  }

  const sbom = JSON.stringify({ components: [{ name: "aiohttp", version: "3.14.5" }] });

  it("uses a signed lock when the release has one", async () => {
    const lock = "aiohttp==3.14.5 --hash=sha256:" + "a".repeat(64) + "\n";
    expect(await served({ [wheelName]: "wheel", "stayawakebot-0.17.3-requirements.lock": lock })).toEqual({
      kind: "verified", wheelName, wheel: new Uint8Array(Buffer.from("wheel")), dependencies: { lock },
    });
  });

  it("otherwise pins the versions in the signed SBOM", async () => {
    const result = await served({ [wheelName]: "wheel", [sbomName]: sbom }, { [`${sbomName}.sig`]: signer.sign(sbom) });
    expect(result).toMatchObject({ kind: "verified", dependencies: { pins: ["aiohttp==3.14.5"] } });
  });

  it("refuses a file that does not match what was signed", async () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ "SHA256SUMS.sig": signer.sign("other") }, "not signed"],
      [{ [wheelName]: "changed" }, "does not match"],
      [{ [`${sbomName}.sig`]: signer.sign("{}") }, "no signed list"],
    ];
    for (const [change, says] of cases) {
      const result = await served({ [wheelName]: "wheel", [sbomName]: sbom }, { [`${sbomName}.sig`]: signer.sign(sbom), ...change });
      expect(result.kind === "failed" && result.detail).toContain(says);
    }
  });

  it("finds no package for a machine saw does not build for", async () => {
    expect(await served({ "stayawakebot-0.17.3-py3-none-macosx_11_0_arm64.whl": "wheel" })).toMatchObject({ kind: "failed" });
  });
});

describe("installing a release beside the running saw", () => {
  const ok = (stdout = ""): RunResult => ({ exitCode: 0, stdout, stderr: "", timedOut: false, cancelled: false, overflowed: false, spawnError: null });

  function deps(over: Partial<UpdateDeps> & { says?: string; verdicts?: Record<string, string> } = {}) {
    const ran: string[][] = [];
    const removed: string[] = [];
    const samples: Record<string, string>[] = [];
    const made: UpdateDeps = {
      env: { platform: "linux", homedir: "/home/a", pathVariable: "/usr/bin", isExecutableFile: (file) => file === "/usr/bin/python3" },
      run: async (binary, args) => {
        ran.push([binary, ...args]);
        if (args.includes("-c")) {
          return ok("3 12\n/usr/bin/python3.12\n");
        }
        return args[0] === "--version" ? ok(over.says ?? "saw (stayawakebot) 0.17.3\n") : ok();
      },
      dir: "/store/saw/versions/0.17.3",
      version: "0.17.3",
      wheel: "/tmp/dl/stayawakebot-0.17.3-py3-none-manylinux_2_17_x86_64.whl",
      dependencies: { pins: ["aiohttp==3.14.5"] },
      writeFile: () => undefined,
      removeDir: (dir) => removed.push(dir),
      sample: (files) => {
        samples.push(files);
        return `/tmp/sample-${samples.length}`;
      },
      scan: async (_binary, folder) => ((over.verdicts ?? { "/tmp/sample-1": "infected", "/tmp/sample-2": "clean" })[folder] as never),
      ...over,
    };
    return { made, ran, removed, samples };
  }

  const pip = ["/store/saw/versions/0.17.3/bin/python", "-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--only-binary=:all:"];

  it("installs the checked wheel with the SBOM's versions, then checks the new saw", async () => {
    const { made, ran, samples } = deps();
    expect(await installUpdate(made)).toEqual({ kind: "installed", binary: "/store/saw/versions/0.17.3/bin/saw", dir: "/store/saw/versions/0.17.3" });
    expect(ran).toContainEqual([...pip, "/tmp/dl/stayawakebot-0.17.3-py3-none-manylinux_2_17_x86_64.whl", "aiohttp==3.14.5"]);
    expect(samples).toEqual([INFECTED_SAMPLE, CLEAN_SAMPLE]);
  });

  it("installs by hash when the release signs a lock", async () => {
    const { made, ran } = deps({ dependencies: { lock: "stayawakebot==0.17.3 --hash=sha256:" + "a".repeat(64) + "\n" } });
    await installUpdate(made);
    expect(ran).toContainEqual([...pip, "--require-hashes", "--no-deps", "--find-links", "/tmp/dl", "-r", "/store/saw/versions/0.17.3/saw.lock.txt"]);
  });

  it("removes what it installed when the new saw is not that release, or misses a check", async () => {
    for (const over of [{ says: "saw (stayawakebot) 0.17.2\n" }, { verdicts: { "/tmp/sample-1": "clean" } }, { verdicts: { "/tmp/sample-1": "infected", "/tmp/sample-2": "infected" } }]) {
      const { made, removed } = deps(over);
      expect((await installUpdate(made)).kind).toBe("failed");
      expect(removed).toContain("/store/saw/versions/0.17.3");
    }
  });
});
