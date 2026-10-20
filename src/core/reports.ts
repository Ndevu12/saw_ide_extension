import type { AuditDetails, AuditVerdict, FixDetails, FixOutcome, HookStatus } from "./actions";
import type { Finding, TargetResult } from "./contract";
import { block, inline, prose, webLink } from "./markdown";
import type { ScanOutcome } from "./scan";
import type { FolderVerdict } from "./verdict";

// The reports the editor shows in a Markdown preview, built from what saw reported. A report is
// built twice: for the preview, with the evidence saw quoted, and for the copy the extension keeps
// in its own storage, without it.

export type Copy = "preview" | "saved";
export type SettledScan = Exclude<ScanOutcome, { kind: "cancelled" }>;

/** A saw command the operator started, as it runs and once it has finished. */
export interface CommandRun {
  startedAt: number;
  finishedAt?: number;
  /** saw's own human report, as far as it has got. */
  said: string;
  stopped?: "cancelled" | "timed-out" | "not-started";
  /** Why saw could not be started, when it could not. */
  detail?: string;
}

const AUDIT_HINT =
  "Before you change any password or token, run **saw: Audit This Machine**: changing them while something on the machine still watches them can set off code that deletes your files.";

export function when(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function sawVersion(version: string | undefined): string {
  return version ? ` with saw ${inline(version, 40)}` : "";
}

function footer(copy: Copy, source: string): string {
  const evidence = copy === "preview" ? " Evidence is shown here only: the copy the extension keeps withholds it." : " This is the copy the extension keeps: evidence is withheld.";
  return `---\n\n*Built by the saw extension from ${source}. Nothing from the folder ran to make it.${evidence}*`;
}

function said(run: CommandRun): string {
  const text = run.said.trim();
  if (!text) {
    return run.finishedAt === undefined ? "*saw has not said anything yet.*" : "*saw printed no report.*";
  }
  return block(text);
}

function stoppedLine(run: CommandRun): string | undefined {
  switch (run.stopped) {
    case "cancelled":
      return "It was stopped before it finished.";
    case "timed-out":
      return "It was stopped because it did not finish in time.";
    case "not-started":
      return `saw could not be started${run.detail ? `: ${prose(run.detail, 300)}` : "."}`;
    default:
      return undefined;
  }
}

// --- scan -----------------------------------------------------------------------------------------

const VERDICT_TITLE: Record<FolderVerdict, string> = {
  clean: "Clean",
  residue: "Residue",
  suspicious: "Suspicious",
  incomplete: "Not verified",
  infected: "Infected",
};

const VERDICT_MEANING: Record<FolderVerdict, string> = {
  clean: "saw found none of the supply-chain worm techniques it knows.",
  residue: "Nothing here runs, but saw found traces an infection left behind.",
  suspicious: "saw found something to review by hand. It does not report it as malware.",
  incomplete: "saw could not finish checking this folder, so it is not known to be clean.",
  infected: "Malicious code is in this folder.",
};

const VERDICT_ADVICE: Record<FolderVerdict, string[]> = {
  clean: ["This is not a guarantee: review code you did not write before you run it."],
  residue: ["Review the findings below. What saw found does not run, but it is not what the project would carry."],
  suspicious: [
    "Read the findings below before you install dependencies, build, run anything here, or trust the folder.",
    "If you cannot tell whether a finding is yours, treat the folder as infected.",
  ],
  incomplete: [
    "Do not trust the folder, install its dependencies or run anything in it until saw can finish.",
    "The reasons are below. When they are dealt with, run **saw: Scan Workspace**.",
  ],
  infected: [
    "Do not trust this folder, install its dependencies, build or run it.",
    "Use **Fix…** on the folder in the saw view, or **saw: Fix Folder…**: saw removes what it confirms and prepares the clean-up on a new local branch. Nothing from the folder runs while it does, and nothing is pushed.",
    AUDIT_HINT,
  ],
};

const AUTOMATIC = new Set(["remove-file", "remove-foreign-vscode", "strip-gitignore-markers"]);

function remedy(finding: Finding): string {
  if (finding.confidence === "confirmed" && AUTOMATIC.has(finding.remediation)) {
    return "**Fix…** removes this.";
  }
  if (finding.remediation === "report") {
    return "Reported only: there is nothing to remove.";
  }
  if (finding.remediation === "manual") {
    return "saw does not remove this itself: deal with it by hand.";
  }
  return `saw's remedy: ${inline(finding.remediation, 60)}.`;
}

const RANK = ["critical", "high", "medium", "low"];

function strongestFirst(a: Finding, b: Finding): number {
  return RANK.indexOf(a.severity) - RANK.indexOf(b.severity);
}

function findingItem(finding: Finding, copy: Copy): string {
  const where = inline(finding.line ? `${finding.path}:${finding.line}` : finding.path, 200);
  const lines = [
    `**${finding.severity}** · ${where} · ${inline(finding.signatureId, 80)}`,
    prose(finding.description, 400),
    remedy(finding),
  ];
  if (finding.fixAdvice) {
    lines.push(`To fix it: ${inline(finding.fixAdvice, 300)}`);
  }
  if (finding.reference) {
    lines.push(`Details: ${webLink(finding.reference)}`);
  }
  if (finding.evidence && copy === "saved") {
    lines.push(`*Evidence withheld from this copy (${finding.evidence.length} characters).*`);
  }
  // A hard line break (two spaces) keeps each line inside the list item.
  const item = `- ${lines.join("  \n  ")}`;
  if (!finding.evidence || copy === "saved") {
    return item;
  }
  return `${item}\n\n${block(finding.evidence, 4000).split("\n").map((line) => `  ${line}`).join("\n")}\n`;
}

const GROUPS: Array<{ title: string; pick: (result: TargetResult) => Finding[] }> = [
  { title: "Confirmed", pick: (r) => r.findings.filter((f) => f.confidence === "confirmed") },
  { title: "To review by hand", pick: (r) => r.findings.filter((f) => f.confidence === "heuristic") },
  { title: "Residue", pick: (r) => r.findings.filter((f) => f.confidence === "residue") },
  { title: "Dependency advisories", pick: (r) => r.advisories },
  { title: "For your information", pick: (r) => [...r.informational, ...r.findings.filter((f) => f.confidence === "informational")] },
];

export interface ScanReportInput {
  folderName: string;
  folderPath: string;
  scanning: boolean;
  fixing: boolean;
  outcome: SettledScan | undefined;
  sawVersion: string | undefined;
}

export function scanReport(input: ScanReportInput, copy: Copy): string {
  const out = [`# saw scan: ${prose(input.folderName, 120)}`, ""];
  if (input.fixing) {
    out.push("> **saw is fixing this folder.** It is scanned again when the fix is done.", "");
  } else if (input.scanning) {
    out.push(`> **Scanning now.** This report updates when saw finishes${input.outcome ? "; below is the previous scan" : ""}.`, "");
  }
  const { outcome } = input;
  if (!outcome) {
    out.push(input.scanning ? "" : "saw has not scanned this folder in this window yet.", "", `Folder: ${inline(input.folderPath, 400)}`);
    return out.join("\n");
  }
  out.push(`## ${VERDICT_TITLE[outcome.verdict]}`, "", VERDICT_MEANING[outcome.verdict], "");
  const scannedAt = outcome.kind === "scanned" ? ` at ${inline(outcome.payload.generatedAt, 60)}` : "";
  out.push(`- Folder: ${inline(input.folderPath, 400)}`, `- Scanned${scannedAt} in ${seconds(outcome.durationMs)}${sawVersion(input.sawVersion)}`);
  const results = outcome.kind === "scanned" ? outcome.payload.results : [];
  const findings = results.flatMap((r) => r.findings);
  if (outcome.kind === "scanned") {
    const count = (confidence: string) => findings.filter((f) => f.confidence === confidence).length;
    const advisories = results.reduce((n, r) => n + r.advisories.length, 0);
    out.push(`- ${findings.length} finding${findings.length === 1 ? "" : "s"}: ${count("confirmed")} confirmed, ${count("heuristic")} to review, ${count("residue")} residue; ${advisories} dependency advisor${advisories === 1 ? "y" : "ies"}`);
  }
  out.push("", "## What to do", "", ...VERDICT_ADVICE[outcome.verdict].map((line) => `- ${line}`), "");
  if (findings.length) {
    out.push("To open a finding's file at its line, click it in the saw view or the Problems panel.", "");
  }
  if (outcome.reasons.length) {
    out.push("## Why it is not verified", "", ...outcome.reasons.map((reason) => `- ${prose(reason, 600)}`), "");
  }
  for (const result of results) {
    const heading = results.length > 1 ? `## ${inline(result.target, 300)}: ${prose(result.verdict, 20)}` : undefined;
    const sections: string[] = [];
    for (const group of GROUPS) {
      const picked = group.pick(result).sort(strongestFirst);
      if (picked.length) {
        sections.push(`### ${group.title} (${picked.length})`, "", ...picked.map((f) => findingItem(f, copy)), "");
      }
    }
    if (result.error) {
      sections.push("### Not read", "", prose(result.error, 1000), "");
    }
    if (result.notes.length) {
      sections.push("### Coverage notes", "", ...result.notes.map((note) => `- ${prose(note, 600)}`), "");
    }
    if (sections.length) {
      out.push(...(heading ? [heading, ""] : []), ...sections);
    }
  }
  if (outcome.kind === "scanned" && !findings.length && !results.some((r) => r.advisories.length)) {
    out.push("*No findings.*", "");
  }
  out.push(footer(copy, "`saw scan --json`"));
  return out.join("\n");
}

// --- fix ------------------------------------------------------------------------------------------

const MAX_LISTED = 50;

function listed(items: string[], render: (item: string) => string): string[] {
  const more = items.length - MAX_LISTED;
  return [...items.slice(0, MAX_LISTED).map((item) => `- ${render(item)}`), ...(more > 0 ? [`- *and ${more} more*`] : [])];
}

/** Where the clean-up is, what it removed, and what became of the operator's own work. */
function fixDetails(details: FixDetails): string[] {
  const out: string[] = [];
  if (details.branch) {
    const base = details.base ? ` from ${inline(details.base, 120)}` : "";
    out.push("## Where the clean-up is", "", `The local branch ${inline(details.branch, 120)}${base}. To review it: ${inline(`git diff ${details.base || "HEAD"}...${details.branch}`, 300)}`, "");
  }
  if (details.partial) {
    out.push("**saw could clean only part of what it found.** Read saw's report below for what is left.", "");
  }
  if (details.historyHoldsPayload) {
    out.push("**git history still holds the malicious code.** Removing it from the checkout does not remove it from the history: do not push old commits, and consider a fresh clone once the clean-up is merged.", "");
  }
  const work = details.uncommitted;
  if (work) {
    out.push("## Your uncommitted work", "");
    if (work.branch) {
      out.push(`Saved on the local branch ${inline(work.branch, 120)}: ${work.files} file(s).`);
      if (work.withheld) out.push(`- ${work.withheld} file(s) kept out of it because saw found them malicious.`);
      if (work.unsaved) out.push(`- ${work.unsaved} file(s) could not be saved and are on disk only.`);
      if (work.unread) out.push(`- ${work.unread} file(s) could not be read.`);
    } else {
      out.push(`**It could not be saved on a branch, and is on disk only.**${work.reason ? ` ${prose(work.reason, 400)}` : ""}`);
    }
    out.push("");
  }
  if (details.needsReview.length) {
    out.push("## Left for you to decide", "", ...listed(details.needsReview, (item) => prose(item, 400)), "");
  }
  if (details.removed.length) {
    out.push("## Removed", "", ...listed(details.removed, (item) => inline(item, 300)), "");
  }
  return out;
}

export interface FixReportInput {
  folderName: string;
  folderPath: string;
  run: CommandRun;
  outcome: FixOutcome | undefined;
  sawVersion: string | undefined;
}

export function fixReport(input: FixReportInput, copy: Copy): string {
  const { run, outcome } = input;
  const out = [`# saw fix: ${prose(input.folderName, 120)}`, ""];
  let title: string;
  let advice: string[];
  const stopped = stoppedLine(run);
  if (run.finishedAt === undefined) {
    title = "Fixing now";
    advice = ["saw is cleaning this folder. Its report appears below as it works, and the folder is scanned again when it is done."];
  } else if (stopped) {
    title = "Stopped";
    advice = [stopped, "The folder is scanned again. Look in Source Control for anything saw had already changed."];
  } else if (outcome?.kind === "prepared") {
    title = outcome.details?.partial ? "Clean-up prepared, in part" : "Clean-up prepared";
    advice = [
      "saw removed what it confirmed from the checkout and prepared the clean-up on a new local branch. Nothing was pushed.",
      ...(outcome.needsReview ? ["Part of it needs you: saw's report below says what."] : []),
      "Review the branch in Source Control before you push it or open a pull request. saw's report below names the branches it made.",
    ];
  } else if (outcome?.kind === "skipped") {
    title = "Nothing to remove";
    advice = ["saw confirmed nothing to remove, so it changed nothing."];
  } else {
    title = "Not fixed";
    advice = [`saw could not fix this folder: ${prose(outcome?.kind === "failed" ? outcome.cause : "saw fix printed no result", 400)}`];
  }
  out.push(`## ${title}`, "", ...advice.map((line) => `- ${line}`), `- ${AUDIT_HINT}`, "");
  if (outcome?.kind === "prepared" && outcome.details) {
    out.push(...fixDetails(outcome.details));
  }
  const finished = run.finishedAt === undefined ? "" : `, took ${seconds(run.finishedAt - run.startedAt)}`;
  out.push(`- Folder: ${inline(input.folderPath, 400)}`, `- Started ${when(run.startedAt)}${finished}${sawVersion(input.sawVersion)}`, "");
  out.push("## saw's report", "", said(run), "", footer(copy, "`saw fix --json` and saw's own report"));
  return out.join("\n");
}

// --- audit ----------------------------------------------------------------------------------------

export interface AuditReportInput {
  run: CommandRun | undefined;
  verdict: AuditVerdict | undefined;
  /** saw's own rotation-safety sentence. */
  sentence: string | undefined;
  details?: AuditDetails | undefined;
  sawVersion: string | undefined;
}

const AUDIT_TITLE: Record<AuditVerdict, string> = {
  "no-hazard": "No hazard found",
  "to-confirm": "Safe once you confirm the items below",
  "rotation-unsafe": "Do not change your passwords or tokens yet",
  incomplete: "Not known to be safe",
  failed: "The audit did not finish",
};

const AUDIT_ADVICE: Record<AuditVerdict, string> = {
  "no-hazard": "saw found nothing on this machine that makes changing credentials unsafe. Check anything saw's report below asks you to confirm.",
  "to-confirm": "saw found nothing that makes changing credentials unsafe, provided the items below are yours. If any is not, treat this as an incident: do not change anything yet.",
  "rotation-unsafe": "Something on this machine still watches your credentials. Act on saw's report below first, then audit again before you change anything.",
  incomplete: "saw could not read all of this machine, so changing credentials is not known to be safe. saw's report below says what it could not read.",
  failed: "This machine was not checked. saw's report below may say why; run **saw: Audit This Machine** again.",
};

function auditFinding(f: AuditDetails["findings"][number]): string[] {
  const head = [f.severity && `**${prose(f.severity, 20)}**`, f.confidence && prose(f.confidence, 20), f.title ? prose(f.title, 300) : inline(f.id, 120)].filter(Boolean).join(" · ");
  const lines = [`- ${head}`];
  if (f.detail) lines.push(`  ${prose(f.detail, 800)}`);
  if (f.process) lines.push(`  Process ${f.process.pid}: ${inline(f.process.exe, 300)}`);
  if (f.fix) lines.push(`  To deal with it: ${inline(f.fix, 300)}`);
  return lines;
}

/** saw's audit findings, the ones to confirm first, then what it could not read and what it covered. */
function auditDetails(details: AuditDetails): string[] {
  const out: string[] = [];
  const confirm = details.findings.filter((f) => details.toConfirm.includes(f.id));
  const rest = details.findings.filter((f) => !details.toConfirm.includes(f.id));
  if (confirm.length) {
    out.push("## Confirm these are yours", "", ...confirm.flatMap(auditFinding), "");
  }
  if (rest.length) {
    out.push("## Findings", "", ...rest.slice(0, MAX_LISTED).flatMap(auditFinding), ...(rest.length > MAX_LISTED ? [`- *and ${rest.length - MAX_LISTED} more in saw's report*`] : []), "");
  }
  if (details.incomplete.length) {
    out.push("## Not read", "", ...details.incomplete.map((i) => `- ${inline(i.probe, 120)}: ${prose(i.reason, 400)}`), "");
  }
  if (details.scopeNotes.length) {
    out.push("## What this audit covers", "", ...details.scopeNotes.map((note) => `- ${prose(note, 400)}`), "");
  }
  return out;
}

export function auditReport(input: AuditReportInput, copy: Copy): string {
  const out = ["# saw audit: this machine", ""];
  const { run, verdict } = input;
  if (!run) {
    out.push("This machine has not been audited from this editor yet. Run **saw: Audit This Machine**.", "", `- ${AUDIT_HINT}`);
    return out.join("\n");
  }
  const stopped = stoppedLine(run);
  if (run.finishedAt === undefined) {
    out.push("## Auditing now", "", "saw is checking this machine. Its report appears below as it works.", "");
  } else if (stopped || !verdict) {
    out.push("## Stopped", "", stopped ?? "The audit did not finish.", "");
  } else {
    out.push(`## ${AUDIT_TITLE[verdict]}`, "", AUDIT_ADVICE[verdict], "");
    if (input.sentence) {
      out.push(`> ${prose(input.sentence, 600)}`, "");
    }
    if (input.details) {
      out.push(...auditDetails(input.details));
    }
  }
  const finished = run.finishedAt === undefined ? "" : `, took ${seconds(run.finishedAt - run.startedAt)}`;
  out.push(`- Started ${when(run.startedAt)}${finished}${sawVersion(input.sawVersion)}`, "", "## saw's report", "", said(run), "", footer(copy, "`saw audit` and its own report"));
  return out.join("\n");
}

// --- hooks ----------------------------------------------------------------------------------------

export interface HooksReportInput {
  status: HookStatus | undefined;
  checkedAt: number | undefined;
  /** The last install or repair started from the editor. */
  change: (CommandRun & { subcommand: "install" | "repair" }) | undefined;
  sawVersion: string | undefined;
}

export function hooksReport(input: HooksReportInput, copy: Copy): string {
  const out = ["# saw scan-on-clone hooks", ""];
  const { status } = input;
  if (!status) {
    out.push("## Checking", "", "saw has not said yet whether its hooks are in place.", "");
  } else if (status.kind === "installed" && !status.problems.length) {
    out.push("## In place", "", `Every clone, pull and branch switch is scanned before anything in it runs${status.events.length ? ` (${status.events.map((e) => inline(e, 40)).join(", ")})` : ""}.`, "");
  } else if (status.kind === "installed") {
    out.push("## Need repair", "", "saw's hooks are installed but not fully working:", "", ...status.problems.map((p) => `- ${prose(p, 600)}`), "", "Run **saw: Repair Scan-on-Clone Hooks**.", "");
  } else if (status.kind === "not-installed") {
    out.push("## Not installed", "", "Clones, pulls and branch switches are not scanned. Run **saw: Install Scan-on-Clone Hooks** so saw checks every repository before anything in it runs.", "");
  } else {
    out.push("## Unknown", "", `saw could not say whether its hooks are in place: ${prose(status.detail, 600)}`, "");
  }
  if (input.checkedAt !== undefined) {
    out.push(`- Checked ${when(input.checkedAt)}${sawVersion(input.sawVersion)}`, "");
  }
  const { change } = input;
  if (change) {
    const state = change.finishedAt === undefined ? "running now" : (stoppedLine(change) ?? `finished in ${seconds(change.finishedAt - change.startedAt)}`);
    out.push(`## Last ${inline(`saw hook ${change.subcommand}`)}`, "", `Started ${when(change.startedAt)}; ${state}`, "", said(change), "");
  }
  out.push(footer(copy, "`saw hook status`"));
  return out.join("\n");
}
