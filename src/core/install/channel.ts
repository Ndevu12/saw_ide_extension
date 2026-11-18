import { createHash } from "node:crypto";

import { atLeast, parseRelease, type Version } from "../version";

// The saw releases this extension accepts without a release of its own. saw's release workflow
// publishes a version. This extension's channel, a file on its own default branch, approves it
// with the hash of every file to install. A saw update needs both, so a stolen saw tag or PyPI
// upload alone reaches no one.

export const CHANNEL_URL = "https://raw.githubusercontent.com/Ndevu12/saw_ide_extension/main/channel/saw.json";

/** How long an approved release waits before it is installed on its own. The person can install it sooner. */
export const UPDATE_WAIT_MS = 3 * 24 * 60 * 60_000;

export interface ChannelRelease {
  version: string;
  /** When saw published it; the wait counts from here. */
  releasedAt: number;
  /** A release that closes a detection gap or a vulnerability skips the wait. */
  security: boolean;
  /** The oldest extension that reads this saw. */
  minExtension: string;
  /** The hash-locked requirements to install, relative to the channel file. */
  lock: { path: string; sha256: string };
  /** Whether PyPI had provenance from saw's release workflow for every file when it was approved. */
  provenance: boolean;
  notesUrl: string;
}

export interface Channel {
  releases: ChannelRelease[];
  /** Versions that must not run. A saw on this list is moved off it at once. */
  blocked: string[];
}

const VERSION_TEXT = /^\d+\.\d+\.\d+$/;
const LOCK_PATH = /^locks\/\d+\.\d+\.\d+\.txt$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function readChannel(text: string): Channel | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (parsed as { schema_version?: unknown }).schema_version !== 1) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const releases = Array.isArray(record["releases"]) ? record["releases"].map(readRelease).filter((r): r is ChannelRelease => r !== undefined) : [];
  const blocked = Array.isArray(record["blocked"]) ? record["blocked"].filter((v): v is string => typeof v === "string" && VERSION_TEXT.test(v)) : [];
  return { releases, blocked };
}

function readRelease(value: unknown): ChannelRelease | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const r = value as Record<string, unknown>;
  const lock = r["lock"] as Record<string, unknown> | undefined;
  const releasedAt = typeof r["released_at"] === "string" ? Date.parse(r["released_at"]) : NaN;
  if (typeof r["version"] !== "string" || !VERSION_TEXT.test(r["version"]) || Number.isNaN(releasedAt)
    || typeof r["min_extension"] !== "string" || !VERSION_TEXT.test(r["min_extension"])
    || !lock || typeof lock["path"] !== "string" || !LOCK_PATH.test(lock["path"]) || typeof lock["sha256"] !== "string" || !SHA256.test(lock["sha256"])) {
    return undefined;
  }
  const notes = typeof r["notes_url"] === "string" && r["notes_url"].startsWith("https://github.com/Ndevu12/stayAwakeBot/") ? r["notes_url"] : `https://github.com/Ndevu12/stayAwakeBot/releases/tag/v${r["version"]}`;
  return {
    version: r["version"],
    releasedAt,
    security: r["security"] === true,
    minExtension: r["min_extension"],
    lock: { path: lock["path"], sha256: lock["sha256"] },
    provenance: r["provenance"] === true,
    notesUrl: notes,
  };
}

export function lockUrl(release: ChannelRelease): string {
  return new URL(release.lock.path, CHANNEL_URL).toString();
}

/** The lock as the channel recorded it, and naming the release it is for, or undefined. */
export function checkLock(text: string, release: ChannelRelease): string | undefined {
  if (createHash("sha256").update(text).digest("hex") !== release.lock.sha256) {
    return undefined;
  }
  return new RegExp(`^stayawakebot==${release.version.replace(/\./g, "\\.")}\\b`, "m").test(text) && /--hash=sha256:[0-9a-f]{64}/.test(text) ? text : undefined;
}

export type UpdateChoice =
  | { kind: "none" }
  /** Approved, but still in its wait. `dueAt` is when it installs on its own. */
  | { kind: "waiting"; release: ChannelRelease; dueAt: number }
  | { kind: "due"; release: ChannelRelease; why: "waited" | "security" | "blocked" }
  /** The running saw is blocked, and no approved release replaces it. */
  | { kind: "blocked-stuck" };

export interface UpdateContext {
  current: Version;
  extension: string;
  now: number;
  /** Versions the person went back from: not installed again on their own. */
  declined: readonly string[];
}

export function chooseUpdate(channel: Channel, context: UpdateContext): UpdateChoice {
  const currentText = context.current.join(".");
  const blocked = channel.blocked.includes(currentText);
  const extension = parseRelease(context.extension);
  const newest = channel.releases
    .filter((release) => !channel.blocked.includes(release.version))
    .filter((release) => extension !== null && atLeast(extension, release.minExtension))
    .filter((release) => {
      const version = parseRelease(release.version);
      return version !== null && atLeast(version, currentText) && release.version !== currentText;
    })
    .sort((a, b) => (atLeast(parseRelease(a.version) ?? [0, 0, 0], b.version) ? -1 : 1))[0];
  if (!newest) {
    return blocked ? { kind: "blocked-stuck" } : { kind: "none" };
  }
  if (blocked) {
    return { kind: "due", release: newest, why: "blocked" };
  }
  const dueAt = newest.releasedAt + UPDATE_WAIT_MS;
  if (context.declined.includes(newest.version)) {
    return { kind: "waiting", release: newest, dueAt: Number.POSITIVE_INFINITY };
  }
  if (newest.security) {
    return { kind: "due", release: newest, why: "security" };
  }
  return context.now >= dueAt ? { kind: "due", release: newest, why: "waited" } : { kind: "waiting", release: newest, dueAt };
}
