import * as path from "node:path";

import { FEATURES, supports, type Capabilities } from "../capabilities";
import { plain } from "../text";

// `--progress=jsonl` (stayawakebot#1814): one JSON event per line on stderr. saw then keeps its
// human report off stderr, so it is asked for only where the extension does not show that report.
// Progress only says what saw is doing; a verdict never comes from it.

export const PROGRESS_ARGS = ["--progress=jsonl"] as const;

export function progressArgs(capabilities: Capabilities): string[] {
  return supports(capabilities, FEATURES.progress) ? [...PROGRESS_ARGS] : [];
}

/** Where saw is: the step or target it is on, and how many there are. */
export interface Progress {
  label: string;
  index: number | undefined;
  of: number | undefined;
  /** saw's estimate, from its plan for a target (`scan.plan`). */
  estimateSeconds?: number;
  /** When saw expects to finish, carried from its plan to the events after it. */
  dueAt?: number;
}

const position = (value: unknown): number | undefined => (Number.isInteger(value) && (value as number) >= 0 ? (value as number) : undefined);

const targetName = (target: string) => plain(path.basename(target) || target, 80);

/** The progress an event moves saw to, `null` when saw is done, or undefined for an event that says nothing. */
export function readEvent(line: string): Progress | null | undefined {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!event || typeof event !== "object") {
    return undefined;
  }
  const e = event as Record<string, unknown>;
  switch (e["event"]) {
    case "step":
      return typeof e["label"] === "string" && e["label"] ? { label: plain(e["label"], 80), index: position(e["index"]), of: position(e["of"]) } : undefined;
    case "target":
      return typeof e["path"] === "string" && e["path"] ? { label: targetName(e["path"]), index: position(e["index"]), of: position(e["of"]) } : undefined;
    case "plan": {
      const files = position(e["files"]);
      const estimate = position(e["estimate_seconds"]);
      if (typeof e["target"] !== "string" || !e["target"] || files === undefined) {
        return undefined;
      }
      return { label: `${targetName(e["target"])}: ${files.toLocaleString("en")} files`, index: undefined, of: undefined, ...(estimate !== undefined ? { estimateSeconds: estimate } : {}) };
    }
    case "progress":
      return typeof e["target"] === "string" && e["target"] && typeof e["phase"] === "string" && e["phase"]
        ? { label: `${targetName(e["target"])}: ${plain(e["phase"], 40)}`, index: position(e["done"]), of: position(e["total"]) }
        : undefined;
    case "done":
      return null;
    default:
      return undefined;
  }
}

/** "checking running processes (3/9), about 12s left", or the label alone when saw gives no count or estimate. */
export function describeProgress(progress: Progress, now = Date.now()): string {
  const { label, index, of, dueAt } = progress;
  const counted = index !== undefined && of !== undefined && of > 0 ? `${label} (${Math.min(index, of)}/${of})` : label;
  const left = dueAt === undefined ? 0 : Math.round((dueAt - now) / 1000);
  return left >= 1 ? `${counted}, about ${left}s left` : counted;
}

/**
 * Splits stderr as it arrives into progress events and everything else: a line that is not an
 * event (a traceback, or a saw that ignored the flag) is passed on as text.
 */
export class ProgressLines {
  private partial = "";
  private dueAt: number | undefined;

  constructor(
    private readonly onProgress: (progress: Progress | null) => void,
    private readonly onText: (text: string) => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  feed(chunk: string): void {
    const lines = (this.partial + chunk).split("\n");
    this.partial = lines.pop() ?? "";
    for (const line of lines) {
      this.line(`${line}\n`);
    }
  }

  /** Hand on what is left once saw has exited. */
  end(): void {
    if (this.partial) {
      this.line(this.partial);
      this.partial = "";
    }
  }

  private line(line: string): void {
    const trimmed = line.trim();
    if (trimmed.startsWith("{")) {
      const progress = readEvent(trimmed);
      if (progress !== undefined) {
        this.onProgress(this.timed(progress));
        return;
      }
      if (isJsonObject(trimmed)) {
        return;
      }
    }
    this.onText(line);
  }

  private timed(progress: Progress | null): Progress | null {
    if (!progress) {
      this.dueAt = undefined;
      return null;
    }
    if (progress.estimateSeconds !== undefined) {
      this.dueAt = this.now() + progress.estimateSeconds * 1000;
    }
    return this.dueAt === undefined ? progress : { ...progress, dueAt: this.dueAt };
  }
}

/** An event this extension does not know is ignored, not shown as saw's words. */
function isJsonObject(line: string): boolean {
  try {
    const parsed: unknown = JSON.parse(line);
    return !!parsed && typeof parsed === "object" && "event" in parsed;
  } catch {
    return false;
  }
}

/** stderr without the progress events, for messages that quote what saw said. */
export function withoutEvents(stderr: string): string {
  let text = "";
  const lines = new ProgressLines(
    () => undefined,
    (t) => (text += t),
  );
  lines.feed(stderr);
  lines.end();
  return text;
}
