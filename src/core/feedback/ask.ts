import type { ChatButton, ChatCard } from "../chat/transcript";
import type { FolderVerdict } from "../scan/verdict";

// When Chat may ask for a rating. The ask is earned by a hold or by quiet scans, and a
// dismissal lasts for the rest of that extension version.

export interface FeedbackMemory {
  quiet: Record<string, number>;
  /** The scan already counted for a folder, so a redraw does not count it again. */
  scanIds: Record<string, string>;
  holds: number;
  holdIds: string[];
  /** Which sentence the card uses. A hold replaces a quiet run. */
  last: "held" | "quiet";
  dismissedMoments: number;
  dismissedVersion: string;
  /** A rating or a star. The card does not ask again on its own. */
  supported: boolean;
}

export const EMPTY_FEEDBACK: FeedbackMemory = {
  quiet: {},
  scanIds: {},
  holds: 0,
  holdIds: [],
  last: "quiet",
  dismissedMoments: 0,
  dismissedVersion: "",
  supported: false,
};

const QUIET = new Set<FolderVerdict>(["clean", "residue"]);
const QUIET_EVERY = 3;

export function readMemory(value: unknown): FeedbackMemory {
  if (!value || typeof value !== "object") {
    return EMPTY_FEEDBACK;
  }
  const record = value as Partial<FeedbackMemory>;
  const quiet: Record<string, number> = {};
  if (record.quiet && typeof record.quiet === "object") {
    for (const [folder, count] of Object.entries(record.quiet)) {
      if (typeof count === "number" && count >= 0) {
        quiet[folder] = count;
      }
    }
  }
  const scanIds: Record<string, string> = {};
  if (record.scanIds && typeof record.scanIds === "object") {
    for (const [folder, id] of Object.entries(record.scanIds)) {
      if (typeof id === "string" && id !== "") {
        scanIds[folder] = id;
      }
    }
  }
  return {
    quiet,
    scanIds,
    holds: typeof record.holds === "number" && record.holds >= 0 ? record.holds : 0,
    holdIds: Array.isArray(record.holdIds) ? record.holdIds.filter((id): id is string => typeof id === "string") : [],
    last: record.last === "held" ? "held" : "quiet",
    dismissedMoments: typeof record.dismissedMoments === "number" ? record.dismissedMoments : 0,
    dismissedVersion: typeof record.dismissedVersion === "string" ? record.dismissedVersion : "",
    supported: record.supported === true,
  };
}

/** Count a settled scan. Only a clean or residue result can earn the quiet ask. */
export function noteScan(memory: FeedbackMemory, folder: string, scanId: string, verdict: FolderVerdict): FeedbackMemory {
  if (memory.scanIds[folder] === scanId) {
    return memory;
  }
  const scanIds = { ...memory.scanIds, [folder]: scanId };
  if (!QUIET.has(verdict)) {
    return { ...memory, scanIds };
  }
  const count = (memory.quiet[folder] ?? 0) + 1;
  return {
    ...memory,
    scanIds,
    quiet: { ...memory.quiet, [folder]: count },
    ...(count % QUIET_EVERY === 0 ? { last: "quiet" as const } : {}),
  };
}

/** Count one held update. The same hold is not counted twice. */
export function noteHold(memory: FeedbackMemory, holdId: string): FeedbackMemory {
  if (memory.holdIds.includes(holdId)) {
    return memory;
  }
  return {
    ...memory,
    holds: memory.holds + 1,
    holdIds: [...memory.holdIds, holdId].slice(-40),
    last: "held",
  };
}

/** Holds, plus one for every three quiet scans of a folder. */
export function moments(memory: FeedbackMemory): number {
  const quiet = Object.values(memory.quiet).reduce((sum, count) => sum + Math.floor(count / QUIET_EVERY), 0);
  return memory.holds + quiet;
}

/** Which sentence the card uses. `ready` is the command, before a moment has one of its own. */
export function askKind(memory: FeedbackMemory): "held" | "quiet" | "ready" {
  return moments(memory) === 0 ? "ready" : memory.last;
}

export function askBlocked(folders: { verdict?: FolderVerdict; checking: boolean; scanning: boolean; deciding: boolean; fixing: boolean }[]): boolean {
  return folders.some((folder) => folder.checking
    || folder.scanning
    || folder.deciding
    || folder.fixing
    || folder.verdict === "infected"
    || folder.verdict === "incomplete"
    || folder.verdict === "suspicious");
}

/** Whether Chat shows the card on its own. A forced open from the command is separate. */
export function showAsk(memory: FeedbackMemory, version: string, blocked: boolean): boolean {
  if (memory.supported || blocked) {
    return false;
  }
  const earned = moments(memory);
  if (earned === 0 || earned <= memory.dismissedMoments) {
    return false;
  }
  return memory.dismissedVersion !== version;
}

export function dismissAsk(memory: FeedbackMemory, version: string): FeedbackMemory {
  return { ...memory, dismissedMoments: moments(memory), dismissedVersion: version };
}

export function supportAsk(memory: FeedbackMemory): FeedbackMemory {
  return { ...memory, supported: true };
}

const HELD = "saw held an update before it changed this folder. A rating is how the next person finds it.";
const QUIET_COPY = "saw has checked this folder and found nothing it knows. If that matched what you saw, a rating helps the next person.";
const READY = "A rating helps the next person find saw. You can also report a problem or ask for something.";
const WHICH = "Is this about the editor, or about what saw found?";

const RATE: ChatButton = { act: "feedback:rate", label: "Rate", tone: "primary" };
const STAR: ChatButton = { act: "feedback:star", label: "Star", tone: "secondary" };
const REPORT: ChatButton = { act: "feedback:report", label: "Report a problem", tone: "secondary" };
const REQUEST: ChatButton = { act: "feedback:request", label: "Request a feature", tone: "secondary" };
const NOT_NOW: ChatButton = { act: "feedback:dismiss", label: "Not now", tone: "secondary" };

/** The card. `ready` is the command, before a hold or a quiet run has a sentence of its own. */
export function feedbackCard(kind: "held" | "quiet" | "ready", choosing: boolean): ChatCard {
  if (choosing) {
    return {
      badge: "feedback",
      title: "Report a problem",
      tone: "neutral",
      paragraphs: [WHICH],
      rows: [],
      actions: [
        { act: "feedback:editor", label: "The editor", tone: "primary" },
        { act: "feedback:found", label: "What saw found", tone: "secondary" },
        { act: "feedback:back", label: "Back", tone: "secondary" },
      ],
    };
  }
  const sentence = kind === "held" ? HELD : kind === "quiet" ? QUIET_COPY : READY;
  return {
    badge: "feedback",
    title: "saw",
    tone: "neutral",
    paragraphs: [sentence],
    rows: [],
    actions: [RATE, STAR, REPORT, REQUEST, NOT_NOW],
  };
}

export function reviewUrl(appName: string): string {
  if (appName === "Visual Studio Code") {
    return "https://marketplace.visualstudio.com/items?itemName=ndevu12.stayawakebot&ssr=false#review-details";
  }
  return "https://open-vsx.org/extension/Ndevu12/stayawakebot/reviews";
}

export function starUrl(): string {
  return "https://github.com/Ndevu12/saw_ide_extension";
}

export interface FeedbackFacts {
  extensionVersion: string;
  sawVersion: string;
  editor: string;
  verdict: string;
}

/** A GitHub issue with the versions filled in. Nothing from the folder is included. */
export function issueUrl(where: "extension" | "saw", kind: "problem" | "feature", facts: FeedbackFacts): string {
  const base = where === "saw"
    ? "https://github.com/Ndevu12/stayAwakeBot/issues/new"
    : "https://github.com/Ndevu12/saw_ide_extension/issues/new";
  const title = kind === "feature" ? "Feature request" : "Problem";
  const lines = [
    kind === "feature" ? "What should the editor do?" : "What happened?",
    "",
    `Extension ${facts.extensionVersion}`,
    `saw ${facts.sawVersion}`,
    `Editor ${facts.editor}`,
    `Verdict ${facts.verdict}`,
  ];
  if (where === "extension" && kind === "problem") {
    lines.push("", "If this is about what saw found, file it on the saw tracker instead.");
  }
  return `${base}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(lines.join("\n"))}`;
}
