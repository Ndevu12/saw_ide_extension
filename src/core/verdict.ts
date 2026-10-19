import type { ScanPayload } from "./contract";

// saw's process status (stayawake/utils/exitcodes.py). Only CLEAN and FINDINGS carry a verdict;
// a suspicious result also exits CLEAN, so the verdict itself always comes from the report.
export const EXIT = {
  CLEAN: 0,
  FINDINGS: 1,
  INCOMPLETE: 2,
  DID_NOT_RUN: 4,
} as const;

/** Ordered weakest to strongest. A folder shows the strongest state any of its targets reached. */
export const FOLDER_VERDICTS = ["clean", "residue", "suspicious", "incomplete", "infected"] as const;
export type FolderVerdict = (typeof FOLDER_VERDICTS)[number];

export function strongest(a: FolderVerdict, b: FolderVerdict): FolderVerdict {
  return FOLDER_VERDICTS.indexOf(a) >= FOLDER_VERDICTS.indexOf(b) ? a : b;
}

export interface Judgement {
  verdict: FolderVerdict;
  /** Why the folder could not be shown clean, when that is the reason. Never set for a clean folder. */
  reasons: string[];
}

/**
 * Combine the report and the exit status into one verdict for a folder.
 * A run that could not establish its answer never reads as clean: an errored target, a status
 * that disagrees with the report, or a status saw does not define all become `incomplete`.
 */
export function judge(payload: ScanPayload, exitCode: number | null): Judgement {
  let verdict: FolderVerdict = "clean";
  const reasons: string[] = [];
  for (const result of payload.results) {
    verdict = strongest(verdict, result.verdict);
    if (result.error) {
      verdict = strongest(verdict, "incomplete");
      reasons.push(`${result.target}: ${result.error}`);
    }
  }
  if (payload.results.length === 0) {
    verdict = strongest(verdict, "incomplete");
    reasons.push("saw reported no targets for this folder");
  }
  const infected = verdict === "infected";
  if (exitCode === EXIT.FINDINGS && !infected) {
    verdict = strongest(verdict, "incomplete");
    reasons.push("saw reported findings that the report does not contain");
  } else if (exitCode === EXIT.CLEAN && infected) {
    reasons.push("saw exited clean on an infected report");
  } else if (exitCode !== EXIT.CLEAN && exitCode !== EXIT.FINDINGS) {
    verdict = strongest(verdict, "incomplete");
    if (exitCode !== EXIT.INCOMPLETE || reasons.length === 0) {
      reasons.push(`saw stopped with status ${exitCode ?? "unknown"}`);
    }
  }
  return { verdict, reasons };
}
