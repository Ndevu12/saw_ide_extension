// A folder's scan results as an editor tab: what saw decided, how to fix it, why, and every finding.

import { pageDocument } from "./brand";
import {
  buttonHtml,
  checkingSentence,
  escapeHtml,
  FIX_FILES,
  FIX_FILES_NOTE,
  FIX_HISTORY,
  FIX_HISTORY_NOTE,
  folderStatus,
  groupFindings,
  historyStillInfected,
  liveLine,
  PAGE_SCRIPT,
  pillHtml,
  liveHtml,
  summaryLine,
  text,
  unheldSentence,
  VERDICT_BADGE,
  VERDICT_TONE,
  type ChatButton,
  type ChatFindingGroup,
  type ChatFolderInput,
  type Tone,
} from "./transcript";

/** Places listed under one kind of finding. The full report has the rest. */
export const PAGE_PLACES = 24;

export interface VerdictPage {
  title: string;
  path?: string;
  status: string;
  tone: Tone;
  live?: string;
  summary?: string;
  notices: { text: string; tone: Tone }[];
  reasons: string[];
  primary?: ChatButton;
  actions: ChatButton[];
  /** The two fixes, each its own saw command, when the folder is or was infected. */
  fixes: FixStep[];
  groups: ChatFindingGroup[];
  advisories: number;
  /** Said when there is nothing to list. */
  empty?: string;
}

/** One fix: its saw command, what it changes, where it stands, and its own button. */
export interface FixStep {
  title: string;
  command: string;
  /** A caution read before anything else. */
  warning?: string;
  does: string[];
  status?: { text: string; tone: Tone };
  action?: ChatButton;
  /** What the button runs and how far it reaches. */
  note?: string;
  details?: ChatButton;
}

const FILES_DOES = [
  "Removes what saw confirmed as malicious from the files in this folder now, with the installed packages, build output and lockfile. Reinstall and rebuild afterwards.",
  "Puts the fixed files on a new local branch for you to review, and saves your uncommitted work on a local saw/uncommitted-… branch.",
  "Pushes nothing. Past commits still hold the infection.",
];

const HISTORY_DOES = [
  "Rewrites every past commit that holds the malicious code, keeping each commit's message and author.",
  "Force-pushes each branch that held one. Everyone with a clone must reset to the new branches.",
  "Needs admin rights on the repository, a clone that is up to date, and your git name and email. A protected branch is not force-pushed: the fixed history is pushed beside it for a pull request.",
  "saw discard cannot undo it.",
];

function fixSteps(folder: ChatFolderInput, index: string | number): FixStep[] {
  const infected = folder.verdict === "infected";
  if (!infected && !folder.cleanup && !folder.history) {
    return [];
  }
  const idle = folder.phase === "idle";
  const running = folder.phase !== "idle" && folder.phase !== "scanning" ? folder.treating : undefined;
  const cleanup = folder.cleanup;
  const filesStatus: FixStep["status"] = running === "files"
    ? { text: folder.phase === "deciding" ? "Waiting for your choice." : "Running now.", tone: "neutral" }
    : cleanup
      ? cleanup.partial || cleanup.needsYou
        ? { text: "Done in part. Files fix details says what is left for you.", tone: "warn" }
        : { text: cleanup.branch ? `Done. The fixed files are on ${cleanup.branch}.` : "Done.", tone: "ok" }
      : undefined;
  const historyNeeded = historyStillInfected(folder);
  const historyStatus: FixStep["status"] = running === "history"
    ? { text: folder.phase === "deciding" ? "Waiting for your choice." : "Running now.", tone: "neutral" }
    : folder.history === "done"
      ? { text: "Done. Everyone with a clone must reset to the new branches.", tone: "ok" }
      : folder.history === "review"
        ? { text: "Needs you. Git history fix details says what.", tone: "warn" }
        : folder.history === "failed"
          ? { text: "Did not finish. Git history fix details says why.", tone: "warn" }
          : historyNeeded
            ? { text: "Needed: git history still holds the infection.", tone: "bad" }
            : undefined;
  const files: FixStep = {
    title: "Fix infection in files",
    command: "saw fix",
    does: FILES_DOES,
    ...(filesStatus ? { status: filesStatus } : {}),
    ...(infected && idle ? { action: FIX_FILES(index), note: FIX_FILES_NOTE } : {}),
    ...(cleanup ? { details: { act: `fix-report:${index}`, label: "Files fix details", tone: "secondary" } } : {}),
  };
  const history: FixStep = {
    title: "Fix infection in git history",
    command: "saw fix amend",
    warning: "This changes history you share with others. Tell everyone who works on this repository before you run it.",
    does: HISTORY_DOES,
    ...(historyStatus ? { status: historyStatus } : {}),
    ...(idle && (infected || historyNeeded || folder.history === "review" || folder.history === "failed") ? { action: FIX_HISTORY(index), note: FIX_HISTORY_NOTE } : {}),
    ...(folder.history ? { details: { act: `amend-report:${index}`, label: "Git history fix details", tone: "secondary" } } : {}),
  };
  return [files, history];
}

export function verdictPage(folder: ChatFolderInput, index: string | number): VerdictPage {
  const notices: { text: string; tone: Tone }[] = [];
  if (folder.held) {
    notices.push({ text: `saw stopped an update (${VERDICT_BADGE[folder.held.verdict]}). The folder was not changed.`, tone: folder.held.verdict === "infected" ? "bad" : "warn" });
  }
  if (folder.unheld) {
    notices.push({ text: unheldSentence(folder.unheldFrom), tone: folder.unheldFrom === "open" ? "warn" : "bad" });
  }
  if (folder.olderSaw) {
    notices.push({ text: folder.olderSaw, tone: "warn" });
  }
  if (folder.decision) {
    notices.push({ text: folder.decision, tone: "warn" });
  }
  const idle = folder.phase === "idle";
  const actions: ChatButton[] = [];
  let primary: ChatButton | undefined;
  if (folder.phase === "deciding") {
    primary = { act: `decide:${index}`, label: "Choose what to keep", tone: "primary" };
  } else if (!folder.verdict && idle) {
    primary = { act: `scan:${index}`, label: "Scan this folder", tone: "primary" };
  }
  if (folder.verdict && idle) {
    actions.push({ act: `scan:${index}`, label: "Scan again", tone: "secondary" });
  }
  if (folder.verdict || folder.phase !== "idle") {
    actions.push({ act: `report:${index}`, label: "Full details", tone: "secondary" });
  }
  const groups = groupFindings(folder.findings, index, PAGE_PLACES);
  const live = folder.checking ? checkingSentence(folder.checkAbout, folder.checkStep) : liveLine(folder);
  const summary = summaryLine(folder.findings);
  const empty = !folder.verdict
    ? idle ? "This folder has not been scanned yet. A scan only reads it." : undefined
    : !folder.findings.length ? "saw found nothing harmful that it knows of." : undefined;
  return {
    title: folder.name,
    ...(folder.path ? { path: folder.path } : {}),
    status: folderStatus(folder),
    tone: folder.verdict ? VERDICT_TONE[folder.verdict] : "neutral",
    ...(live ? { live } : {}),
    ...(summary ? { summary } : {}),
    notices,
    reasons: [...folder.reasons, ...(folder.held?.reasons ?? [])],
    ...(primary ? { primary } : {}),
    actions,
    fixes: fixSteps(folder, index),
    groups,
    advisories: folder.advisories ?? 0,
    ...(empty ? { empty } : {}),
  };
}

/** The tab. Every string from a scan is escaped, so it cannot become markup. */
export function renderVerdict(page: VerdictPage, nonce: string): string {
  const path = page.path ? `<p class="path">${text(page.path, 300)}</p>` : "";
  const summary = page.summary ? `<p class="sum">${text(page.summary, 160)}</p>` : "";
  const bar = page.primary || page.actions.length
    ? `<div class="bar">${page.primary ? buttonHtml(page.primary) : ""}${page.actions.map(buttonHtml).join("")}</div>`
    : "";
  const notices = page.notices.map((notice) => `<p class="notice ${notice.tone}">${text(notice.text)}</p>`).join("");
  const reasons = page.reasons.length
    ? `<section class="block"><h2>Why saw says this</h2><ul class="why">${page.reasons.map((line) => `<li>${text(line)}</li>`).join("")}</ul></section>`
    : "";
  const findings = page.groups.length
    ? `<section class="block"><h2>What was found</h2><ul class="findings">${page.groups.map(groupHtml).join("")}</ul></section>`
    : page.empty ? `<p class="empty">${text(page.empty)}</p>` : "";
  const advisories = page.advisories
    ? `<p class="hint">${page.advisories} ${page.advisories === 1 ? "package has a known security problem" : "packages have known security problems"}. Full details lists them.</p>`
    : "";
  const body = `<main class="verdict ${page.tone}">
    <header class="hero">
      <div class="top">${pillHtml(page.status)}<h1 class="title">${text(page.title, 120)}</h1></div>
      ${path}${liveHtml(page.live)}${summary}${bar}
    </header>
    ${notices}${fixesHtml(page.fixes)}${reasons}${findings}${advisories}
  </main>`;
  return pageDocument(nonce, body, PAGE_SCRIPT, "editor");
}

function fixesHtml(steps: FixStep[]): string {
  if (!steps.length) {
    return "";
  }
  return `<section class="block"><h2>Fix the infection</h2><p class="hint">Two separate saw commands. Each runs only when you choose it.</p><div class="fixes">${steps.map(stepHtml).join("")}</div></section>`;
}

function stepHtml(step: FixStep, at: number): string {
  const warning = step.warning ? `<p class="notice warn">${text(step.warning)}</p>` : "";
  const status = step.status ? `<p class="status ${step.status.tone}"><span class="dot ${step.status.tone}"></span>${text(step.status.text)}</p>` : "";
  const note = step.note ? `<p class="note">${text(step.note)}</p>` : "";
  const buttons = step.action || step.details
    ? `<div class="step-actions">${step.action ? buttonHtml(step.action) : ""}${step.details ? buttonHtml(step.details) : ""}</div>${note}`
    : "";
  return `<article class="fix">
    <header><span class="num">${at + 1}</span><h3>${text(step.title, 80)}</h3><code>${text(step.command, 40)}</code></header>
    ${status}${warning}<ul>${step.does.map((line) => `<li>${text(line)}</li>`).join("")}</ul>${buttons}
  </article>`;
}

function groupHtml(group: ChatFindingGroup): string {
  const count = group.count > 1 ? ` <span class="count">× ${group.count}</span>` : "";
  const more = group.hidden > 0 ? `<span class="more">+${group.hidden} more in Full details</span>` : "";
  return `<li>
    <div class="what"><span class="sev ${group.severity}">${group.severity}</span><span>${text(group.what, 300)}${count}</span></div>
    <div class="places">${group.places.map((place) => `<button type="button" class="place" title="${text(place.label, 300)}" data-act="${escapeHtml(place.act)}">${text(place.label, 160)}</button>`).join("")}${more}</div>
  </li>`;
}
