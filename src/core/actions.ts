import { runProgram } from "./run";
import { EXIT } from "./verdict";
import { atLeast, parseVersion } from "./version";

// `saw fix`, `saw audit` and `saw hook status`, as this extension runs and reads them. Each reading
// errs toward "not known": an outcome it does not recognise is never reported as a success.

/** The first saw whose `fix` reports what it did as JSON. */
export const FIX_SINCE = "0.13.0";

export function canFix(version: string): boolean {
  const parsed = parseVersion(`saw (stayawakebot) ${version}`);
  return parsed !== null && atLeast(parsed, FIX_SINCE);
}

export function fixArgs(folder: string, configPath: string): string[] {
  return ["fix", folder, "--json", "--no-stream", ...(configPath ? ["--config", configPath] : [])];
}

export const REMEDIATIONS = ["prepared", "skipped", "failed", "pr", "fork-pr", "patch", "issue"] as const;
export type Remediation = (typeof REMEDIATIONS)[number];

export type FixOutcome =
  /** saw changed the checkout and prepared the clean-up on a local branch. */
  | { kind: "prepared"; needsReview: boolean }
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
  const results = (parsed as { results?: unknown }).results;
  const first = Array.isArray(results) && results.length === 1 ? (results[0] as Record<string, unknown>) : undefined;
  const remediation = first?.["remediation"];
  if (typeof remediation !== "string" || !(REMEDIATIONS as readonly string[]).includes(remediation)) {
    return { kind: "failed", cause: "saw fix reported something this extension does not read" };
  }
  const cause = typeof first?.["cause"] === "string" ? first["cause"] : "";
  switch (remediation as Remediation) {
    case "prepared":
      return { kind: "prepared", needsReview: exitCode !== EXIT.CLEAN };
    case "skipped":
      return { kind: "skipped" };
    case "failed":
      return { kind: "failed", cause: cause || "saw fix could not clean it" };
    default:
      // A pull request, patch or issue: only with --pr, which this extension never passes.
      return { kind: "failed", cause: `saw fix published a ${remediation}, which was not asked for` };
  }
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

export const AUDIT_ARGS = ["audit", "--no-stream"] as const;

const ROTATION_UNSAFE = 3;

export type AuditVerdict =
  /** Nothing found that makes rotating credentials unsafe; the report may still list items to confirm. */
  | "no-hazard"
  | "rotation-unsafe"
  /** Part of the machine could not be read, so rotating is not known to be safe. */
  | "incomplete"
  | "failed";

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

export const HOOK_STATUS_ARGS = ["hook", "status", "--no-stream"] as const;

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
