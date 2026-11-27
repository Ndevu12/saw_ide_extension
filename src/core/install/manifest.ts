import * as os from "node:os";

export const KNOWN_CONTRACT = 1;

export interface ReleaseWheel {
  os: string;
  arch: string;
  libc?: string;
  minimum?: string;
  file: string;
  sha256: string;
}

export interface ReleaseManifest {
  contract: number;
  security: boolean;
  requirementsLock: string;
  wheels: ReleaseWheel[];
}

export interface Machine {
  os: string;
  arch: string;
  glibc?: string;
  macos?: string;
}

export function manifestName(version: string): string {
  return `stayawakebot-${version}.platforms.json`;
}

const FILE = /^[\w.+-]+$/;
const HASH = /^[0-9a-f]{64}$/;
const VERSION = /^\d+(\.\d+)*$/;

export function readManifest(text: string, version: string): ReleaseManifest | string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return "its platforms manifest cannot be read.";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "its platforms manifest cannot be read.";
  }
  const { contract, security, requirements_lock: lock, wheels } = parsed;
  if (typeof contract !== "number" || !Number.isInteger(contract) || contract < 1) {
    return "its platforms manifest has no contract version.";
  }
  if (contract > KNOWN_CONTRACT) {
    return `its platforms manifest uses contract ${contract}, newer than this extension reads. Update the extension.`;
  }
  if (parsed["version"] !== version || typeof security !== "boolean" || typeof lock !== "string" || !FILE.test(lock) || !Array.isArray(wheels)) {
    return "its platforms manifest is not for this release.";
  }
  const read: ReleaseWheel[] = [];
  for (const entry of wheels as unknown[]) {
    const w = entry as Record<string, unknown> | null;
    const valid = w && typeof w.os === "string" && typeof w.arch === "string" && typeof w.file === "string" && FILE.test(w.file) && typeof w.sha256 === "string" && HASH.test(w.sha256)
      && (w.minimum === undefined || (typeof w.minimum === "string" && VERSION.test(w.minimum)))
      && (w.libc === undefined ? w.os !== "linux" : typeof w.libc === "string");
    if (!valid) {
      return "its platforms manifest has a package entry that cannot be read.";
    }
    read.push({ os: w.os as string, arch: w.arch as string, file: w.file as string, sha256: w.sha256 as string, ...(typeof w.minimum === "string" ? { minimum: w.minimum } : {}), ...(typeof w.libc === "string" ? { libc: w.libc } : {}) });
  }
  return { contract, security, requirementsLock: lock, wheels: read };
}

function atLeast(found: string, minimum: string): boolean {
  const a = found.split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) {
      return x > y;
    }
  }
  return true;
}

export function wheelFor(manifest: ReleaseManifest, machine: Machine): ReleaseWheel | string {
  const wheel = manifest.wheels.find((w) => w.os === machine.os && w.arch === machine.arch);
  if (!wheel) {
    return `it has no package for ${machine.os} ${machine.arch}.`;
  }
  if (wheel.libc === "glibc") {
    if (!machine.glibc) {
      return "its Linux package needs glibc, which this machine does not use.";
    }
    if (wheel.minimum && !atLeast(machine.glibc, wheel.minimum)) {
      return `its Linux package needs glibc ${wheel.minimum}; this machine has ${machine.glibc}.`;
    }
  } else if (wheel.libc !== undefined) {
    return `its package needs ${wheel.libc}, which this extension cannot check.`;
  }
  if (machine.os === "macos" && wheel.minimum && (!machine.macos || !atLeast(machine.macos, wheel.minimum))) {
    return `its macOS package needs macOS ${wheel.minimum}; this machine has ${machine.macos ?? "an unknown version"}.`;
  }
  return wheel;
}

function macosVersion(darwinRelease: string): string | undefined {
  const major = Number(darwinRelease.split(".")[0]);
  if (!Number.isInteger(major) || major < 20) {
    return undefined;
  }
  return String(major >= 25 ? major + 1 : major - 9);
}

export function thisMachine(): Machine {
  const osName = { linux: "linux", darwin: "macos", win32: "windows" }[process.platform as "linux" | "darwin" | "win32"] ?? process.platform;
  const arch = { x64: "x86_64", arm64: "arm64" }[process.arch as "x64" | "arm64"] ?? process.arch;
  let header: { glibcVersionRuntime?: unknown } | undefined;
  try {
    header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: unknown } } | undefined)?.header;
  } catch {
    header = undefined;
  }
  const glibc = typeof header?.glibcVersionRuntime === "string" ? { glibc: header.glibcVersionRuntime } : {};
  const macos = osName === "macos" ? macosVersion(os.release()) : undefined;
  return { os: osName, arch, ...glibc, ...(macos ? { macos } : {}) };
}
