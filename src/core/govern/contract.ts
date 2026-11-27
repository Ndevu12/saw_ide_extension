import { schemaProblem } from "../capabilities";
import type { FolderVerdict } from "../scan/verdict";

// The JSON `saw govern` prints. Schema `govern` version 1. A newer schema is refused.

/** Clean and residue may change the open folder. Anything else waits. */
export function mayRelease(verdict: FolderVerdict): boolean {
  return verdict === "clean" || verdict === "residue";
}

export function verdictArgs(repo: string): string[] {
  return ["govern", "verdict", "--json", "--repo", repo];
}

/** Whether this saw's `govern` help offers `verdict`. Older saw lists prepare and apply only. */
export function offersGovernVerdict(help: string): boolean {
  return help.split("\n").some((line) => /^\s*verdict(\s|$)/.test(line) || /\{[^{}\n]*\bverdict\b/.test(line));
}

/** Whether this saw's `govern` help offers `restore`. */
export function offersGovernRestore(help: string): boolean {
  return help.split("\n").some((line) => /^\s*restore(\s|$)/.test(line) || /\{[^{}\n]*\brestore\b/.test(line));
}

export function restoreArgs(repo: string): string[] {
  return ["govern", "restore", "--json", "--repo", repo];
}

export function letInArgs(repo: string): string[] {
  return ["govern", "let-in", "--repo", repo];
}

type Json = Record<string, unknown>;

function object(stdout: string): Json | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return "saw did not print a JSON report";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "the report is not a JSON object";
  }
  const problem = schemaProblem("govern", parsed);
  return problem ?? (parsed as Json);
}

export type Governed = "let-in" | "not-let-in" | "could-not-answer";

/** Saw's machine code. `reason` is prose and is not matched. */
export type GovernCode = "let-in" | "let-in-by-you" | "unknown-commit" | "tree-changed" | "could-not-answer";

const GOVERNED = new Set<Governed>(["let-in", "not-let-in", "could-not-answer"]);
const CODES = new Set<GovernCode>(["let-in", "let-in-by-you", "unknown-commit", "tree-changed", "could-not-answer"]);

export interface GovernedReading {
  answer: Governed;
  code?: GovernCode;
  head?: string;
  letIn?: string;
}

function commitId(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{40,64}$/.test(value) ? value : undefined;
}

/**
 * Read `saw govern verdict`. An unreadable report is `could-not-answer`. `code` is absent on a
 * saw that only sends the three answers. That is not a tree saw let in.
 */
export function readGoverned(stdout: string): GovernedReading {
  const parsed = object(stdout);
  if (typeof parsed === "string") {
    return { answer: "could-not-answer" };
  }
  const governed = parsed["governed"];
  const answer = typeof governed === "string" && GOVERNED.has(governed as Governed) ? (governed as Governed) : "could-not-answer";
  const codeRaw = parsed["code"];
  const code = typeof codeRaw === "string" && CODES.has(codeRaw as GovernCode) ? (codeRaw as GovernCode) : undefined;
  const head = commitId(parsed["head"]);
  const letIn = commitId(parsed["let_in"]);
  return {
    answer,
    ...(code ? { code } : {}),
    ...(head ? { head } : {}),
    ...(letIn ? { letIn } : {}),
  };
}

/** Put the folder back only for a commit saw did not let in, and only when this saw can do it. */
export function shouldRestore(code: GovernCode | undefined, restoreAvailable: boolean): boolean {
  return restoreAvailable && code === "unknown-commit";
}

export interface RestoreReading {
  restored: boolean;
  reason?: string;
}

/** Read `saw govern restore`. Anything other than an explicit restored report left the folder as it was. */
export function readRestore(stdout: string): RestoreReading {
  const parsed = object(stdout);
  if (typeof parsed === "string") {
    return { restored: false, reason: parsed };
  }
  if (parsed["restored"] === true) {
    return { restored: true };
  }
  const reason = parsed["reason"];
  return { restored: false, ...(typeof reason === "string" && reason !== "" ? { reason } : {}) };
}

export type UnheldDecision = "clear" | "mark" | "leave";

/** What opening a folder does with one verdict. `restore` asks saw to put the folder back. */
export type OpenDecision = "clear" | "restore" | "mark" | "leave";

/**
 * What to do with the tree already open. `undefined` is a timeout or a saw that did not start.
 * No answer leaves the folder alone, including a folder that has no commit yet.
 */
export function openAdmission(reading: GovernedReading | undefined, restoreAvailable: boolean): OpenDecision {
  if (!reading) {
    return "leave";
  }
  const code = reading.code;
  if (code === "could-not-answer" || (code === undefined && reading.answer === "could-not-answer")) {
    return "leave";
  }
  if (code === "let-in" || (code === undefined && reading.answer === "let-in")) {
    return "clear";
  }
  if (shouldRestore(code, restoreAvailable)) {
    return "restore";
  }
  if (code === "unknown-commit" || code === "tree-changed" || reading.answer === "not-let-in") {
    return "mark";
  }
  if (reading.answer === "let-in") {
    return "clear";
  }
  return "leave";
}

/**
 * What to say after a HEAD move. `undefined` means this saw cannot answer. Covered terminals
 * stay quiet in that case, because saw checked what they ran.
 */
export function unheldAfter(answer: Governed | undefined, terminalsCovered: boolean): UnheldDecision {
  if (answer === "let-in") {
    return "clear";
  }
  if (answer === "not-let-in") {
    return "mark";
  }
  if (answer === "could-not-answer") {
    return "leave";
  }
  return terminalsCovered ? "leave" : "mark";
}

export type GovernPhase = "checking" | "held" | "applied" | "finished";

export interface HeldFinding {
  severity: string;
  path: string;
  description: string;
}

/** What saw says about an update it held: what it found, the command, what to do, and whether `saw govern let-in` reviews it. */
export interface HeldDetails {
  command: string | undefined;
  findings: HeldFinding[];
  nextSteps: string[];
  letIn: boolean;
}

/** What saw records for a folder while it checks an update, and how that check ended. */
export interface GovernNotice {
  repo: string;
  phase: GovernPhase;
  step?: string;
  verdict?: FolderVerdict;
  reasons: string[];
  at: number;
  details?: HeldDetails;
}

const PHASES = new Set<GovernPhase>(["checking", "held", "applied", "finished"]);
const VERDICTS = new Set<FolderVerdict>(["clean", "residue", "suspicious", "incomplete", "infected"]);

export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function readFindings(value: unknown): HeldFinding[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item: unknown) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const { severity, path, description } = item as Record<string, unknown>;
    return typeof severity === "string" && typeof path === "string" && typeof description === "string" ? [{ severity, path, description }] : [];
  });
}

function readHeldDetails(record: Record<string, unknown>): HeldDetails | undefined {
  if (!("findings" in record) && !("next_steps" in record) && !("command" in record) && !("let_in" in record)) {
    return undefined;
  }
  const command = record["command"];
  const argv = command && typeof command === "object" ? strings((command as Record<string, unknown>)["argv"]) : [];
  return {
    command: argv.length ? argv.join(" ") : undefined,
    findings: readFindings(record["findings"]),
    nextSteps: strings(record["next_steps"]),
    letIn: record["let_in"] === true,
  };
}

/** Read one of saw's check records. Undefined when the file is not one this extension shows. */
export function readNotice(text: string): GovernNotice | undefined {
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
  const phase = record["phase"];
  const repo = record["repo"];
  const at = record["at"];
  if (typeof phase !== "string" || !PHASES.has(phase as GovernPhase) || typeof repo !== "string" || repo === "" || typeof at !== "number") {
    return undefined;
  }
  const verdict = record["verdict"];
  const step = record["step"];
  const details = phase === "held" ? readHeldDetails(record) : undefined;
  return {
    repo,
    phase: phase as GovernPhase,
    ...(typeof step === "string" && step !== "" ? { step } : {}),
    ...(typeof verdict === "string" && VERDICTS.has(verdict as FolderVerdict) ? { verdict: verdict as FolderVerdict } : {}),
    reasons: strings(record["reasons"]),
    at,
    ...(details ? { details } : {}),
  };
}
