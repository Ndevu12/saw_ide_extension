import { createHash } from "node:crypto";

import { atLeast, parseRelease, type Version } from "../version";

export const LATEST_RELEASE_URL = "https://api.github.com/repos/Ndevu12/stayAwakeBot/releases/latest";

export const UPDATE_WAIT_MS = 3 * 24 * 60 * 60_000;

export interface ReleaseAsset {
  name: string;
  url: string;
}

export interface SawRelease {
  version: string;
  publishedAt: number;
  security: boolean;
  notesUrl: string;
  assets: ReleaseAsset[];
}

/** GitHub's latest release: never a draft or pre-release, so marking a release pre-release withdraws it. */
export function readRelease(text: string): SawRelease | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const tag = typeof parsed["tag_name"] === "string" ? /^v(\d+\.\d+\.\d+)$/.exec(parsed["tag_name"]) : null;
  const publishedAt = typeof parsed["published_at"] === "string" ? Date.parse(parsed["published_at"]) : NaN;
  if (!tag?.[1] || Number.isNaN(publishedAt) || parsed["draft"] === true || parsed["prerelease"] === true || !Array.isArray(parsed["assets"])) {
    return undefined;
  }
  const assets = parsed["assets"].flatMap((asset: unknown) => {
    const a = asset as { name?: unknown; browser_download_url?: unknown };
    return typeof a.name === "string" && typeof a.browser_download_url === "string" && a.browser_download_url.startsWith("https://github.com/Ndevu12/stayAwakeBot/releases/download/")
      ? [{ name: a.name, url: a.browser_download_url }]
      : [];
  });
  return {
    version: tag[1],
    publishedAt,
    security: typeof parsed["name"] === "string" && /\bsecurity\b/i.test(parsed["name"]),
    notesUrl: `https://github.com/Ndevu12/stayAwakeBot/releases/tag/v${tag[1]}`,
    assets,
  };
}

export type UpdateChoice =
  | { kind: "none" }
  | { kind: "waiting"; dueAt: number }
  | { kind: "due"; why: "waited" | "security" };

export interface UpdateContext {
  current: Version;
  /** The newest release this machine ran: never moved below, even if a newer one is withdrawn. */
  highest: string | undefined;
  now: number;
  declined: readonly string[];
}

export function chooseUpdate(release: SawRelease, context: UpdateContext): UpdateChoice {
  const version = parseRelease(release.version);
  const floor = context.current.join(".");
  if (!version || release.version === floor || !atLeast(version, floor) || (context.highest && !atLeast(version, context.highest))) {
    return { kind: "none" };
  }
  if (context.declined.includes(release.version)) {
    return { kind: "waiting", dueAt: Number.POSITIVE_INFINITY };
  }
  if (release.security) {
    return { kind: "due", why: "security" };
  }
  const dueAt = release.publishedAt + UPDATE_WAIT_MS;
  return context.now >= dueAt ? { kind: "due", why: "waited" } : { kind: "waiting", dueAt };
}

export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The wheel saw publishes for this machine, if any. */
export function wheelFor(platform: NodeJS.Platform, arch: string, version: string): string | undefined {
  const tag = platform === "linux"
    ? { x64: "manylinux_2_17_x86_64", arm64: "manylinux_2_17_aarch64" }[arch]
    : platform === "darwin" ? { x64: "macosx_11_0_x86_64", arm64: "macosx_11_0_arm64" }[arch] : undefined;
  return tag ? `stayawakebot-${version}-py3-none-${tag}.whl` : undefined;
}

/** `name==version` for each dependency the signed SBOM lists, saw and pip left out. */
export function sbomPins(text: string): string[] | undefined {
  try {
    const components = (JSON.parse(text) as { components?: Array<{ name?: unknown; version?: unknown }> }).components ?? [];
    const pins = components.flatMap((c) => typeof c.name === "string" && typeof c.version === "string" && /^[\w.-]+$/.test(c.name) && /^[\w.+!-]+$/.test(c.version) && !["stayawakebot", "pip"].includes(c.name.toLowerCase()) ? [`${c.name}==${c.version}`] : []);
    return pins.length ? pins : undefined;
  } catch {
    return undefined;
  }
}
