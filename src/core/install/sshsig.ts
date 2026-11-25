import { createHash, createPublicKey, verify } from "node:crypto";

// `ssh-keygen -Y sign`, as saw signs its release files.

class Reader {
  private at = 0;
  constructor(private readonly data: Buffer) {}
  bytes(): Buffer {
    const length = this.data.readUInt32BE(this.at);
    const start = this.at + 4;
    this.at = start + length;
    if (this.at > this.data.length) {
      throw new Error("truncated");
    }
    return this.data.subarray(start, this.at);
  }
  uint32(): number {
    const value = this.data.readUInt32BE(this.at);
    this.at += 4;
    return value;
  }
  take(length: number): Buffer {
    const out = this.data.subarray(this.at, this.at + length);
    this.at += length;
    return out;
  }
}

function sshString(value: Buffer | string): Buffer {
  const data = typeof value === "string" ? Buffer.from(value) : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, data]);
}

function isTrusted(publicKey: Buffer, signers: readonly string[]): boolean {
  return signers.some((line) => {
    const [type, key] = line.trim().split(/\s+/);
    return type === "ssh-ed25519" && key !== undefined && Buffer.from(key, "base64").equals(publicKey);
  });
}

/** True when `signature` is a valid `file` signature over `message` by one of `signers` (`ssh-ed25519 AAAA…` lines). */
export function verifySshSignature(message: Uint8Array, signature: string, signers: readonly string[], expectedNamespace = "file"): boolean {
  try {
    const armored = /-----BEGIN SSH SIGNATURE-----([\s\S]+?)-----END SSH SIGNATURE-----/.exec(signature)?.[1];
    if (!armored) {
      return false;
    }
    const blob = new Reader(Buffer.from(armored.replace(/\s+/g, ""), "base64"));
    if (blob.take(6).toString() !== "SSHSIG" || blob.uint32() !== 1) {
      return false;
    }
    const publicKey = blob.bytes();
    const namespace = blob.bytes();
    const reserved = blob.bytes();
    const hashName = blob.bytes().toString();
    const signed = new Reader(blob.bytes());
    const keyReader = new Reader(publicKey);
    if (!isTrusted(publicKey, signers) || namespace.toString() !== expectedNamespace || keyReader.bytes().toString() !== "ssh-ed25519" || signed.bytes().toString() !== "ssh-ed25519") {
      return false;
    }
    if (hashName !== "sha512" && hashName !== "sha256") {
      return false;
    }
    const digest = createHash(hashName).update(message).digest();
    const data = Buffer.concat([Buffer.from("SSHSIG"), sshString(namespace), sshString(reserved), sshString(hashName), sshString(digest)]);
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: keyReader.bytes().toString("base64url") }, format: "jwk" });
    return verify(null, data, key, signed.bytes());
  } catch {
    return false;
  }
}
