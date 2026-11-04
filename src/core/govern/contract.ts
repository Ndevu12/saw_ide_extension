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
}

/** Clean and residue may change the open folder. Anything else waits. */
export function mayRelease(verdict: FolderVerdict): boolean {
  return verdict === "clean" || verdict === "residue";
}

export function prepareArgs(repo: string, into: string, tool: Tool, args: readonly string[]): string[] {
  return ["govern", "prepare", "--json", "--repo", repo, "--into", into, "--tool", tool, "--", ...args];
}

export function applyArgs(repo: string, into: string): string[] {
  return ["govern", "apply", "--json", "--repo", repo, "--into", into];
}

export function restoreArgs(repo: string, into: string, backTo: string): string[] {
  return ["govern", "restore", "--json", "--repo", repo, "--into", into, "--back-to", backTo];
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

export interface RestoreReading {
  restored: boolean;
  verdict: FolderVerdict;
  reasons: string[];
}

/** Read `saw govern restore`. A restore that did not put the folder back is not treated as done. */
export function readRestore(stdout: string, exitCode: number | null): RestoreReading {
  const parsed = object(stdout);
  if (typeof parsed === "string") {
    return { restored: false, verdict: "incomplete", reasons: [parsed] };
  }
  const prepared = readPrepare(stdout, exitCode);
  return { restored: parsed["restored"] === true, verdict: prepared.verdict, reasons: prepared.reasons };
}
