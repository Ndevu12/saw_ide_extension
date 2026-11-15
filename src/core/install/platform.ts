/** The machine a package must fit. `glibc` is the C library version on glibc Linux; `musl` is true on musl Linux. */
export interface Machine {
  platform: NodeJS.Platform;
  arch?: string;
  glibc?: string;
  musl?: boolean;
}

/** What PyPI lists for one stayawakebot release: the wheel file names, and whether a source package is there. */
export type Release = { kind: "files"; wheels: string[]; source: boolean } | { kind: "unpublished" };

export type Support =
  | { kind: "fits" }
  | { kind: "old-glibc"; needs: string; has: string }
  | { kind: "elsewhere"; on: string[]; source: boolean }
  | { kind: "unpublished" };

const LINUX_ARCH: Record<string, string> = { x64: "x86_64", arm64: "aarch64", ia32: "i686", arm: "armv7l", ppc64: "ppc64le", s390x: "s390x" };
const MANYLINUX_LEGACY: Record<string, string> = { manylinux1: "2.5", manylinux2010: "2.12", manylinux2014: "2.17" };

/** The machine in the words a person reads it: "Linux x86_64", "macOS on Apple silicon". */
export function machineName(machine: Machine): string {
  const arch = machine.arch ?? "";
  switch (machine.platform) {
    case "linux":
      return `Linux ${LINUX_ARCH[arch] ?? (arch || "on an unknown processor")}${machine.musl ? " with musl" : ""}`;
    case "darwin":
      return arch === "arm64" ? "macOS on Apple silicon" : arch === "x64" ? "macOS on Intel" : `macOS ${arch}`.trim();
    case "win32":
      return arch === "arm64" ? "Windows on Arm" : arch === "ia32" ? "32-bit Windows" : arch === "x64" ? "Windows x64" : `Windows ${arch}`.trim();
    default:
      return `${machine.platform} ${arch}`.trim();
  }
}

/** A wheel's platform tags, from its file name. */
export function wheelPlatforms(filename: string): string[] {
  const parts = filename.replace(/\.whl$/, "").split("-");
  return parts.length >= 5 ? (parts[parts.length - 1] ?? "").split(".").filter(Boolean) : [];
}

/** The platform a tag is built for, in the words `machineName` uses. */
export function platformName(tag: string): string[] {
  if (tag === "any") {
    return ["every platform"];
  }
  const linux = /^(manylinux\w*?|musllinux_\d+_\d+|linux)_(x86_64|aarch64|i686|armv7l|ppc64le|s390x)$/.exec(tag);
  if (linux) {
    return [`Linux ${linux[2]}${linux[1]?.startsWith("musllinux") ? " with musl" : ""}`];
  }
  if (tag.startsWith("macosx_")) {
    if (/_(universal2|universal)$/.test(tag)) {
      return ["macOS on Apple silicon", "macOS on Intel"];
    }
    return [tag.endsWith("_arm64") ? "macOS on Apple silicon" : /_(x86_64|intel)$/.test(tag) ? "macOS on Intel" : tag];
  }
  const windows: Record<string, string> = { win_amd64: "Windows x64", win_arm64: "Windows on Arm", win32: "32-bit Windows" };
  return [windows[tag] ?? tag];
}

function atLeast(have: string, need: string): boolean {
  const [haveMajor = 0, haveMinor = 0] = have.split(".").map(Number);
  const [needMajor = 0, needMinor = 0] = need.split(".").map(Number);
  return haveMajor !== needMajor ? haveMajor > needMajor : haveMinor >= needMinor;
}

/** Whether a wheel built for `tag` runs here, and the glibc it needs when it is a newer one. */
export function fits(tag: string, machine: Machine): { fits: boolean; glibc?: string } {
  if (tag === "any") {
    return { fits: true };
  }
  const arch = machine.arch ?? "";
  switch (machine.platform) {
    case "linux": {
      const want = LINUX_ARCH[arch];
      const match = /^(manylinux1|manylinux2010|manylinux2014|manylinux_(\d+)_(\d+)|musllinux_(\d+)_(\d+))_(\w+)$/.exec(tag);
      if (!want || !match || match[6] !== want) {
        return { fits: false };
      }
      if (match[1]?.startsWith("musllinux")) {
        return { fits: machine.musl === true };
      }
      if (machine.musl) {
        return { fits: false };
      }
      const needs = match[2] ? `${match[2]}.${match[3]}` : MANYLINUX_LEGACY[match[1] ?? ""] ?? "0.0";
      return !machine.glibc || atLeast(machine.glibc, needs) ? { fits: true } : { fits: false, glibc: needs };
    }
    case "darwin":
      if (!tag.startsWith("macosx_")) {
        return { fits: false };
      }
      return { fits: /_(universal2|universal)$/.test(tag) || (arch === "arm64" ? tag.endsWith("_arm64") : /_(x86_64|intel)$/.test(tag)) };
    case "win32":
      return { fits: tag === ({ x64: "win_amd64", arm64: "win_arm64", ia32: "win32" } as Record<string, string>)[arch] };
    default:
      return { fits: false };
  }
}

/** The file list from PyPI's JSON for one release (`/pypi/stayawakebot/<version>/json`). */
export function readRelease(text: string): Release | undefined {
  try {
    const value = JSON.parse(text) as { urls?: { packagetype?: unknown; filename?: unknown; yanked?: unknown }[] };
    if (!Array.isArray(value.urls)) {
      return undefined;
    }
    const files = value.urls.filter((file) => typeof file.filename === "string" && file.yanked !== true);
    return {
      kind: "files",
      wheels: files.filter((file) => file.packagetype === "bdist_wheel").map((file) => file.filename as string),
      source: files.some((file) => file.packagetype === "sdist"),
    };
  } catch {
    return undefined;
  }
}

/** Whether the release has a ready-built package for this machine, and which platforms it has one for when not. */
export function support(release: Release, machine: Machine): Support {
  if (release.kind === "unpublished") {
    return release;
  }
  let glibc: string | undefined;
  for (const tag of release.wheels.flatMap(wheelPlatforms)) {
    const result = fits(tag, machine);
    if (result.fits) {
      return { kind: "fits" };
    }
    if (result.glibc && (!glibc || atLeast(glibc, result.glibc))) {
      glibc = result.glibc;
    }
  }
  if (glibc && machine.glibc) {
    return { kind: "old-glibc", needs: glibc, has: machine.glibc };
  }
  const on = [...new Set(release.wheels.flatMap(wheelPlatforms).flatMap(platformName))];
  return { kind: "elsewhere", on, source: release.source };
}

/** pip's "could not find a version" line: the package it looked for, and the releases it could use here. */
export function pipWanted(output: string): { name: string; versions: string[] } | undefined {
  const match = /Could not find a version that satisfies the requirement ([A-Za-z0-9][A-Za-z0-9._-]*)[^\s(]*\s*\(from versions:\s*([^)]*)\)/.exec(output);
  if (!match?.[1]) {
    return undefined;
  }
  const listed = (match[2] ?? "").trim();
  return { name: match[1], versions: listed === "none" || !listed ? [] : listed.split(/,\s*/) };
}
