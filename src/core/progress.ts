import * as path from "node:path";

import { FEATURES, supports, type Capabilities } from "./capabilities";
import { plain } from "./text";

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
}

const position = (value: unknown): number | undefined => (Number.isInteger(value) && (value as number) >= 0 ? (value as number) : undefined);

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
      return typeof e["path"] === "string" && e["path"] ? { label: plain(path.basename(e["path"]) || e["path"], 80), index: position(e["index"]), of: position(e["of"]) } : undefined;
    case "done":
      return null;
    default:
      return undefined;
  }
}

/** "checking running processes (3/9)", or the label alone when saw gives no count. */
export function describeProgress(progress: Progress): string {
  const { label, index, of } = progress;
  return index !== undefined && of !== undefined && of > 0 ? `${label} (${Math.min(index, of)}/${of})` : label;
}

/**
 * Splits stderr as it arrives into progress events and everything else: a line that is not an
 * event (a traceback, or a saw that ignored the flag) is passed on as text.
 */
export class ProgressLines {
  private partial = "";

  constructor(
    private readonly onProgress: (progress: Progress | null) => void,
    private readonly onText: (text: string) => void = () => undefined,
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
        this.onProgress(progress);
        return;
      }
      if (isJsonObject(trimmed)) {
        return;
      }
    }
    this.onText(line);
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
