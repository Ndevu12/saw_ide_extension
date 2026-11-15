import { atLeast, parseRelease } from "../version";

// Moving the saw this extension installed up to the release it pins. When that fails, the saw that
// is installed keeps scanning, and it is marked as behind, because a folder it shows as clean may
// still hold what the pinned release finds.

/** Why the saw that runs is older than the release this extension installs. */
export interface Behind {
  pinned: string;
  cause: string;
}

interface Ready {
  kind: "ready";
  version: string;
  behind?: Behind;
}

interface Unavailable {
  kind: "unavailable";
  reason: string;
  message: string;
}

export interface MoveSteps<R extends Ready, U extends Unavailable> {
  /** Install the pinned release and find it. */
  install(): Promise<R | U>;
  /** Find the saw that is installed now, in case the attempt removed it. */
  keep(): Promise<R | U>;
  /** Tell the operator the install failed, naming the saw that keeps running, when one does. */
  failed(moved: U, keeping: string | undefined): void;
  warn(message: string): void;
}

/** `found` marked as behind `pinned` when it is older, so what shows it can say so. */
export function behindPin<F extends Ready | Unavailable>(found: F, pinned: string, cause: string): F {
  if (found.kind !== "ready") {
    return found;
  }
  const version = parseRelease(found.version);
  return version && atLeast(version, pinned) ? found : { ...found, behind: { pinned, cause } };
}

/**
 * Install the pinned release. When that does not work, keep the saw that is installed, marked as
 * behind. When none is left, the failed install is the answer, since the installer already said why.
 */
export async function moveOrKeep<R extends Ready, U extends Unavailable>(pinned: string, steps: MoveSteps<R, U>): Promise<R | U> {
  const moved = await steps.install();
  if (moved.kind === "ready") {
    // Another window may have held the install, with or without success: what runs can still be older.
    return behindPin(moved, pinned, `saw ${pinned} was not in place after the install.`);
  }
  const kept = await steps.keep();
  steps.failed(moved, kept.kind === "ready" ? kept.version : undefined);
  if (kept.kind !== "ready") {
    return moved;
  }
  const cancelled = moved.reason === "install-cancelled";
  const cause = cancelled ? `Installing saw ${pinned} was cancelled.` : moved.message;
  steps.warn(`saw ${pinned} ${cancelled ? "was not installed, because installing it was cancelled" : "could not be installed"}, so saw ${kept.version} keeps running. ${cancelled ? "" : moved.message}`.trim());
  return behindPin(kept, pinned, cause);
}

/** The saw that gave a folder's verdict, and whether it was behind the pinned release then. */
export interface ScannedBy {
  version: string;
  behind?: Behind;
}

/**
 * The older saw behind a folder's verdict, while that verdict is shown. It belongs to the verdict,
 * not to the saw running now, so it holds while an install runs and until a newer saw rescans.
 */
export function olderSawOf(state: { last: unknown; scannedBy: ScannedBy | undefined }): { version: string; behind: Behind } | undefined {
  const by = state.scannedBy;
  return state.last && by?.behind ? { version: by.version, behind: by.behind } : undefined;
}

/** A short form, for a version line or a notification: `0.16.0, behind the pinned 0.17.0`. */
export function behindVersion(version: string, behind: Behind | undefined): string {
  return behind ? `${version}, behind the pinned ${behind.pinned}` : version;
}

/** What the status bar says about a saw that is behind, ahead of the verdict it shows. */
export function behindNotice(version: string, behind: Behind): string {
  return `saw ${version} is running instead of saw ${behind.pinned}. ${behind.cause} A folder it shows as clean may still hold what saw ${behind.pinned} finds. Run saw: Install or Repair saw to try again.`;
}
