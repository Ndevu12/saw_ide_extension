import { FEATURES, schemaProblem, supports, type Capabilities } from "./capabilities";
import { runProgram } from "./run";
import { EXIT } from "./verdict";
import { atLeast, parseVersion } from "./version";

// `saw fix`, `saw audit` and `saw hook status`, as this extension runs and reads them. Each reading
// errs toward "not known": an outcome it does not recognise is never reported as a success.

/** The first saw whose `fix` reports what it did as JSON, for a saw that cannot say what it supports. */
export const FIX_SINCE = "0.13.0";

export function canFix(version: string, capabilities: Capabilities): boolean {
  if (supports(capabilities, FEATURES.fixJson, "fix")) {
    return true;
  }
  const parsed = parseVersion(`saw (stayawakebot) ${version}`);
  return parsed !== null && atLeast(parsed, FIX_SINCE);
}

export function fixArgs(folder: string, configPath: string): string[] {
  return ["fix", folder, "--json", "--no-stream", ...(configPath ? ["--config", configPath] : [])];
}

export const REMEDIATIONS = ["prepared", "skipped", "failed", "pr", "fork-pr", "patch", "issue"] as const;
export type Remediation = (typeof REMEDIATIONS)[number];

/** What a saw with the fuller `fix --json` (stayawakebot#1813) says about a prepared clean-up. */
export interface FixDetails {
  /** saw could clean only part of what it found. */
  partial: boolean;
  /** The local branch holding the clean-up, and the branch it was made from. */
  branch: string;
  base: string;
  removed: string[];
  /** Where the operator's uncommitted work was put; undefined when saw had none to save. */
  uncommitted: UncommittedWork | undefined;
  /** git history still holds the payload, so rewriting history or a fresh clone is needed to be rid of it. */
  historyHoldsPayload: boolean;
  /** What saw left for the operator to decide. */
  needsReview: string[];
}

export interface UncommittedWork {
  /** Empty when saw could not save it on a branch; `reason` says why. */
  branch: string;
  files: number;
  withheld: number;
  unsaved: number;
  unread: number;
  reason: string;
}

export type FixOutcome =
  /** saw changed the checkout and prepared the clean-up on a local branch. */
  | { kind: "prepared"; needsReview: boolean; details?: FixDetails }
  /** Nothing confirmed, so nothing changed. */
  | { kind: "skipped" }
  | { kind: "failed"; cause: string };

/** Read `saw fix --json` for one folder. The human report goes to stderr; the JSON is all of stdout. */
export function readFix(stdout: string, exitCode: number | null): FixOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { kind: "failed", cause: exitCode === null ? "saw fix did not finish" : "saw fix printed no report" };
  }
  const unreadable = schemaProblem("fix", parsed);
  if (unreadable) {
    return { kind: "failed", cause: unreadable };
  }
  const results = (parsed as { results?: unknown }).results;
  const first = Array.isArray(results) && results.length === 1 ? (results[0] as Record<string, unknown>) : undefined;
  const remediation = first?.["remediation"];
  if (typeof remediation !== "string" || !(REMEDIATIONS as readonly string[]).includes(remediation)) {
    return { kind: "failed", cause: "saw fix reported something this extension does not read" };
  }
  const cause = typeof first?.["cause"] === "string" ? first["cause"] : "";
  switch (remediation as Remediation) {
    case "prepared": {
      const details = fixDetails(first ?? {});
      const needsReview = exitCode !== EXIT.CLEAN || (details !== undefined && (details.partial || details.needsReview.length > 0 || details.historyHoldsPayload));
      return details ? { kind: "prepared", needsReview, details } : { kind: "prepared", needsReview };
    }
    case "skipped":
      return { kind: "skipped" };
    case "failed":
      return { kind: "failed", cause: cause || "saw fix could not clean it" };
    default:
      // A pull request, patch or issue: only with --pr, which this extension never passes.
      return { kind: "failed", cause: `saw fix published a ${remediation}, which was not asked for` };
  }
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const count = (value: unknown): number => (Number.isInteger(value) && (value as number) >= 0 ? (value as number) : 0);
const texts = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

/** The fuller record's fields, or undefined from a saw that writes only the original ones. */
function fixDetails(record: Record<string, unknown>): FixDetails | undefined {
  if (!["partial", "branch", "removed", "uncommitted", "history_holds_payload", "needs_review"].some((key) => key in record)) {
    return undefined;
  }
  const work = record["uncommitted"];
  const uncommitted =
    work && typeof work === "object"
      ? (({ branch, files, withheld, unsaved, unread, reason }: Record<string, unknown>) => ({
          branch: text(branch),
          files: count(files),
          withheld: count(withheld),
          unsaved: count(unsaved),
          unread: count(unread),
          reason: text(reason),
        }))(work as Record<string, unknown>)
      : undefined;
  return {
    partial: record["partial"] === true,
    branch: text(record["branch"]),
    base: text(record["base"]),
    removed: texts(record["removed"]),
    uncommitted,
    historyHoldsPayload: record["history_holds_payload"] === true,
    needsReview: texts(record["needs_review"]),
  };
}

/** Whether git can name who commits in a folder: without that, saw cannot put uncommitted work on a branch. */
export type GitIdentity = "known" | "missing" | "unknown";

const NO_IDENTITY = /identity unknown|empty ident|unable to auto-detect/i;

/** Ask git as `git commit-tree` would. `git var` only reads configuration, so nothing in the folder runs. */
export async function gitIdentity(folder: string, git = "git"): Promise<GitIdentity> {
  for (const variable of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) {
    const run = await runProgram(git, ["-C", folder, "var", variable], { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
    if (run.exitCode !== 0) {
      return NO_IDENTITY.test(run.stderr) ? "missing" : "unknown";
    }
  }
  return "known";
}

export function auditArgs(capabilities: Capabilities): string[] {
  return supports(capabilities, FEATURES.auditJson, "audit") ? ["audit", "--json", "--no-stream"] : ["audit", "--no-stream"];
}

const ROTATION_UNSAFE = 3;

export type AuditVerdict =
  /** Nothing found that makes rotating credentials unsafe; a saw without `audit --json` may still list items to confirm. */
  | "no-hazard"
  /** Safe once the operator confirms the findings saw names are theirs. */
  | "to-confirm"
  | "rotation-unsafe"
  /** Part of the machine could not be read, so rotating is not known to be safe. */
  | "incomplete"
  | "failed";

/** From the most to the least alarming, for when the JSON and the exit status disagree. */
const AUDIT_SEVERITY: readonly AuditVerdict[] = ["rotation-unsafe", "incomplete", "failed", "to-confirm", "no-hazard"];

export function auditVerdict(exitCode: number | null): AuditVerdict {
  switch (exitCode) {
    case EXIT.CLEAN:
      return "no-hazard";
    case ROTATION_UNSAFE:
      return "rotation-unsafe";
    case EXIT.INCOMPLETE:
      return "incomplete";
    default:
      return "failed";
  }
}

/** saw's own rotation-safety sentence from an audit report, so it is repeated rather than paraphrased. */
export function rotationSentence(report: string): string | undefined {
  for (const line of report.split(/\r?\n/)) {
    const at = line.indexOf("Rotation safety:");
    if (at >= 0) {
      return line.slice(at).trim();
    }
  }
  return undefined;
}

export interface AuditFinding {
  id: string;
  severity: string;
  title: string;
  detail: string;
  fix: string;
  confidence: string;
  process: { pid: number; exe: string } | undefined;
}

/** What `saw audit --json` (stayawakebot#1811) says beyond the verdict. */
export interface AuditDetails {
  /** The findings the operator must confirm are theirs, by id. */
  toConfirm: string[];
  findings: AuditFinding[];
  /** The checks saw could not run, and why. */
  incomplete: { probe: string; reason: string }[];
  /** What the audit covered and did not. */
  scopeNotes: string[];
}

export interface AuditResult {
  verdict: AuditVerdict;
  sentence: string | undefined;
  details: AuditDetails | undefined;
}

const ROTATION: Record<string, AuditVerdict> = {
  safe: "no-hazard",
  "safe-once-confirmed": "to-confirm",
  unsafe: "rotation-unsafe",
  incomplete: "incomplete",
};

/**
 * Read an audit. With `--json` the verdict comes from saw's JSON, unless the exit status is more
 * alarming; otherwise from the exit status and saw's own sentence.
 */
export function readAudit(stdout: string, stderr: string, exitCode: number | null, json: boolean): AuditResult {
  const byExit = auditVerdict(exitCode);
  const legacy: AuditResult = { verdict: byExit, sentence: rotationSentence(`${stdout}\n${stderr}`), details: undefined };
  if (!json) {
    return legacy;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return legacy;
  }
  if (schemaProblem("audit", parsed)) {
    return legacy;
  }
  const record = (parsed ?? {}) as Record<string, unknown>;
  const rotation = (record["rotation"] ?? {}) as Record<string, unknown>;
  const fromJson = ROTATION[text(rotation["verdict"])];
  if (!fromJson) {
    return legacy;
  }
  const verdict = AUDIT_SEVERITY.find((v) => v === fromJson || v === byExit) ?? fromJson;
  const findings = (Array.isArray(record["findings"]) ? record["findings"] : []).map((item: unknown): AuditFinding => {
    const f = (item ?? {}) as Record<string, unknown>;
    const proc = f["process"] as Record<string, unknown> | undefined;
    return {
      id: text(f["id"]),
      severity: text(f["severity"]),
      title: text(f["title"]),
      detail: text(f["detail"]),
      fix: text(f["fix"]),
      confidence: text(f["confidence"]),
      process: proc && typeof proc === "object" ? { pid: count(proc["pid"]), exe: text(proc["exe"]) } : undefined,
    };
  });
  const incomplete = (Array.isArray(record["incomplete"]) ? record["incomplete"] : []).map((item: unknown) => {
    const i = (item ?? {}) as Record<string, unknown>;
    return { probe: text(i["probe"]), reason: text(i["reason"]) };
  });
  const sentence = text(rotation["sentence"]);
  return {
    verdict,
    sentence: sentence ? (sentence.startsWith("Rotation safety:") ? sentence : `Rotation safety: ${sentence}`) : legacy.sentence,
    details: { toConfirm: texts(rotation["to_confirm"]), findings, incomplete, scopeNotes: texts(record["scope_notes"]) },
  };
}

export function hookArgs(subcommand: "status" | "install" | "repair", capabilities: Capabilities): string[] {
  return ["hook", subcommand, ...(supports(capabilities, FEATURES.hookStatusJson, "hook-status") ? ["--json"] : []), "--no-stream"];
}

export type HookStatus =
  | { kind: "installed"; events: string[]; problems: string[] }
  | { kind: "not-installed" }
  | { kind: "unknown"; detail: string };

/** Read `saw hook status`, which has no JSON: its first line names the state, and each problem is marked ⚠. */
export function readHookStatus(output: string, exitCode: number | null): HookStatus {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const head = lines.find((line) => line.startsWith("scan-on-clone:"));
  if (exitCode !== EXIT.CLEAN || !head) {
    return { kind: "unknown", detail: lines.at(-1) ?? "saw hook status printed nothing" };
  }
  if (/^scan-on-clone: not installed\b/.test(head)) {
    return { kind: "not-installed" };
  }
  const installed = /^scan-on-clone: INSTALLED(?: \(([^)]*)\))?/.exec(head);
  if (!installed) {
    return { kind: "unknown", detail: head };
  }
  const problems = lines
    .filter((line) => line.startsWith("⚠") || line.startsWith("SAW_HOOK_DISABLED") || line.startsWith("saw has no record"))
    .map((line) => line.replace(/^⚠\s*/, ""));
  const events = (installed[1] ?? "").split(",").map((e) => e.trim()).filter(Boolean);
  return { kind: "installed", events, problems };
}

/**
 * Read `saw hook status --json` (stayawakebot#1812), which `hook install` and `hook repair` also
 * print after their change. Anything else, including text from an older saw, falls back to the text reading.
 */
export function readHookJson(stdout: string, stderr: string, exitCode: number | null): HookStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return readHookStatus(`${stdout}\n${stderr}`, exitCode);
  }
  const unreadable = schemaProblem("hook-status", parsed);
  if (unreadable) {
    return { kind: "unknown", detail: unreadable };
  }
  const record = (parsed ?? {}) as Record<string, unknown>;
  if (typeof record["installed"] !== "boolean") {
    return { kind: "unknown", detail: "saw hook status reported something this extension does not read" };
  }
  if (!record["installed"]) {
    return { kind: "not-installed" };
  }
  const problems = (Array.isArray(record["problems"]) ? record["problems"] : [])
    .map((item: unknown) => {
      const p = (item ?? {}) as Record<string, unknown>;
      const message = text(p["message"]) || text(p["code"]);
      const repair = text(p["repair"]);
      return message && repair ? `${message} (${repair})` : message;
    })
    .filter(Boolean);
  if (record["disabled_by_env"] === true && !problems.some((p) => p.includes("SAW_HOOK_DISABLED"))) {
    problems.unshift("SAW_HOOK_DISABLED is set, so the hooks do nothing.");
  }
  return { kind: "installed", events: texts(record["events"]), problems };
}
