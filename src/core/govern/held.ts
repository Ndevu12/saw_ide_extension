import { parsePayload, type ScanPayload } from "../scan/contract";
import type { FolderVerdict } from "../scan/verdict";
import { commandText } from "./decision";

// An update saw checked and held because of what it found. The stand-in keeps saw's scan of the
// update, so the editor can show what the update would bring, and says what to do next. The
// operator can still let it in: saw advises, the project stays theirs.

/** What the stand-in keeps about a held update, beside its notice. */
export interface HeldRecord {
  repo: string;
  at: number;
  tool: string;
  args: string[];
  verdict: FolderVerdict;
  reasons: string[];
  /** saw's scan of the files the update brings. */
  scan: ScanPayload;
  /** saw's own next steps when it gives them, otherwise the extension's. */
  nextSteps: string[];
}

export function heldFileName(key: string): string {
  return `${key}.held`;
}

/** The verdicts saw holds an update for after checking it. Anything else could not be checked. */
export function foundSomething(verdict: FolderVerdict): boolean {
  return verdict === "suspicious" || verdict === "infected" || verdict === "incomplete";
}

/** saw's `next_steps`, when its answer carries them. */
export function sawNextSteps(answer: unknown): string[] {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
    return [];
  }
  const steps = (answer as Record<string, unknown>)["next_steps"];
  return Array.isArray(steps) ? steps.filter((step): step is string => typeof step === "string" && step.trim() !== "").slice(0, 8) : [];
}

export function heldNextSteps(verdict: FolderVerdict, tool: string, args: readonly string[]): string[] {
  const command = `\`${commandText(tool, args)}\``;
  switch (verdict) {
    case "infected":
      return [
        `Do not bring this update in, check it out, or run anything from it. saw found malicious code in what ${command} would bring.`,
        "Tell whoever pushed it: their account or machine may be compromised.",
        "Before you change any password or token, use Check under Before you change passwords in Chat.",
        "To work on it anyway, for example to fix it, let it in: you are asked to type the folder's name.",
      ];
    case "suspicious":
      return [
        `Review what saw found in what ${command} would bring. It is not reported as malware.`,
        "If every finding is yours or expected, let it in. If you cannot tell, treat it as infected and ask whoever pushed it.",
      ];
    default:
      return [
        `saw could not finish checking what ${command} would bring, so it is not known to be clean.`,
        "Read why below. Let it in only if you trust where it comes from.",
      ];
  }
}

/** The first reason of a finished notice for an update the operator let in after saw held it. */
export const LET_IN_UPDATE = "You let in an update saw held. The folder is scanned now.";

export function readHeldRecord(text: string): HeldRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const { repo, at, tool, args, verdict, reasons, scan, nextSteps } = record;
  if (typeof repo !== "string" || typeof at !== "number" || typeof tool !== "string" || !Array.isArray(args) || !args.every((a) => typeof a === "string")
    || typeof verdict !== "string" || !foundSomething(verdict as FolderVerdict)) {
    return undefined;
  }
  let payload: ScanPayload;
  try {
    payload = parsePayload(JSON.stringify(scan));
  } catch {
    return undefined;
  }
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  return { repo, at, tool, args: args as string[], verdict: verdict as FolderVerdict, reasons: strings(reasons), scan: payload, nextSteps: strings(nextSteps) };
}

/** A few lines for the terminal: the strongest findings first. */
export function findingLines(scan: ScanPayload, limit = 5): string[] {
  const rank = ["critical", "high", "medium", "low"];
  const findings = scan.results.flatMap((result) => result.findings)
    .filter((finding) => finding.confidence !== "informational")
    .sort((a, b) => rank.indexOf(a.severity) - rank.indexOf(b.severity));
  const lines = findings.slice(0, limit).map((finding) => `  • ${finding.severity}: ${finding.description} (${finding.line ? `${finding.path}:${finding.line}` : finding.path})`);
  if (findings.length > limit) {
    lines.push(`  • and ${findings.length - limit} more`);
  }
  return lines;
}
