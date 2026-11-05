import { schemaProblem } from "../capabilities";
import { ContractError, parsePayload } from "../scan/contract";
import { judge, type FolderVerdict } from "../scan/verdict";
import type { Tool } from "./command";

// The JSON `saw govern` prints. Schema `govern` version 1. A newer schema is refused.

export interface GovernConfig {
  enabled: boolean;
  saw: string;
  realGit: string;
  realGh: string;
  timeoutMs: number;
  folders: string[];
  holdingRoot: string;
  markerDir: string;
  resultDir: string;
  /** Ask `saw govern prepare` for the same progress events a scan reports. */
  progress: boolean;
  /** saw's git/gh stand-in, when this saw ships one beside its own program. */
  standin?: string;
  /**
   * `core.hooksPath` for git aimed at an open folder. The operator's own hooks when those sit
   * outside the folder, otherwise an empty directory this extension owns.
   */
  quietHooks?: string;
}

/** Clean and residue may change the open folder. Anything else waits. */
export function mayRelease(verdict: FolderVerdict): boolean {
  return verdict === "clean" || verdict === "residue";
}

export function prepareArgs(repo: string, into: string, tool: Tool, args: readonly string[], progress = false): string[] {
  return ["govern", "prepare", "--json", "--repo", repo, "--into", into, "--tool", tool, ...(progress ? ["--progress=jsonl"] : []), "--", ...args];
}

export function applyArgs(repo: string, into: string): string[] {
  return ["govern", "apply", "--json", "--repo", repo, "--into", into];
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

export interface PrepareReading {
  verdict: FolderVerdict;
  reasons: string[];
  /** Apply the prepared update. False when the verdict must wait, or the document could not be read. */
  release: boolean;
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

/** Read `saw govern prepare`. An unreadable report does not release. */
export function readPrepare(stdout: string, exitCode: number | null): PrepareReading {
  const parsed = object(stdout);
  if (typeof parsed === "string") {
    return { verdict: "incomplete", reasons: [parsed], release: false };
  }
  const scan = parsed["scan"];
  if (scan === undefined) {
    const reason = typeof parsed["reason"] === "string" ? parsed["reason"] : "saw did not include a scan of the update";
    return { verdict: "incomplete", reasons: [reason], release: false };
  }
  try {
    const payload = parsePayload(JSON.stringify(scan));
    const judged = judge(payload, exitCode);
    return { verdict: judged.verdict, reasons: judged.reasons, release: mayRelease(judged.verdict) };
  } catch (error) {
    const why = error instanceof ContractError ? error.message : "saw's scan of the update could not be read";
    return { verdict: "incomplete", reasons: [why], release: false };
  }
}

export interface ApplyReading {
  applied: boolean;
  reason: string | undefined;
}

export type Governed = "let-in" | "not-let-in" | "could-not-answer";

/** Saw's machine code. `reason` is prose and is not matched. */
export type GovernCode = "let-in" | "unknown-commit" | "tree-changed" | "could-not-answer";

const GOVERNED = new Set<Governed>(["let-in", "not-let-in", "could-not-answer"]);
const CODES = new Set<GovernCode>(["let-in", "unknown-commit", "tree-changed", "could-not-answer"]);

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

export function readVerdict(stdout: string): Governed {
  return readGoverned(stdout).answer;
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
 * No answer leaves the folder alone, including a folder that has no commit yet. A terminal
 * stand-in does not change this: nothing has checked this tree yet.
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
 * What to say after a HEAD move. `undefined` means this saw cannot answer. A covered terminal
 * stays quiet in that case, because it leaves no marker for a check it already ran.
 */
export function unheldAfter(answer: Governed | undefined, systemCovered: boolean): UnheldDecision {
  if (answer === "let-in") {
    return "clear";
  }
  if (answer === "not-let-in") {
    return "mark";
  }
  if (answer === "could-not-answer") {
    return "leave";
  }
  return systemCovered ? "leave" : "mark";
}

/**
 * True when two notices are the same check shown twice. Takes a time already shown, the new
 * time, and how far apart the two writers of one check may be.
 */
export function sameCheck(shownAt: number | undefined, at: number, windowMs: number): boolean {
  if (shownAt === undefined) {
    return false;
  }
  const delta = at - shownAt;
  return delta < windowMs && delta >= -1000;
}

export type GovernPhase = "checking" | "held" | "applied" | "finished";

/** What the stand-in writes while an update is in flight, and when it finishes. */
export interface GovernNotice {
  repo: string;
  phase: GovernPhase;
  step?: string;
  verdict?: FolderVerdict;
  reasons: string[];
  at: number;
}

const PHASES = new Set<GovernPhase>(["checking", "held", "applied", "finished"]);
const VERDICTS = new Set<FolderVerdict>(["clean", "residue", "suspicious", "incomplete", "infected"]);

/** Read one stand-in notice. Undefined when the file is not a notice this extension shows. */
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
  const reasons = Array.isArray(record["reasons"]) ? record["reasons"].filter((reason): reason is string => typeof reason === "string") : [];
  return {
    repo,
    phase: phase as GovernPhase,
    ...(typeof step === "string" && step !== "" ? { step } : {}),
    ...(typeof verdict === "string" && VERDICTS.has(verdict as FolderVerdict) ? { verdict: verdict as FolderVerdict } : {}),
    reasons,
    at,
  };
}

/** Read `saw govern apply`. Anything other than an explicit applied report did not change the folder. */
export function readApply(stdout: string): ApplyReading {
  const parsed = object(stdout);
  if (typeof parsed === "string") {
    return { applied: false, reason: parsed };
  }
  if (parsed["applied"] === true) {
    return { applied: true, reason: undefined };
  }
  return { applied: false, reason: typeof parsed["reason"] === "string" ? parsed["reason"] : "saw did not update the folder" };
}

