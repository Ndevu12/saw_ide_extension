// A folder's verdict as an editor tab: what saw decided, why, every finding, and what to do.

import { pageDocument } from "./brand";
import {
  buttonHtml,
  checkingSentence,
  escapeHtml,
  folderStatus,
  groupFindings,
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
  type ChatCleanup,
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
  /** What the primary action does and does not do. */
  hints: string[];
  groups: ChatFindingGroup[];
  advisories: number;
  /** Said when there is nothing to list. */
  empty?: string;
}

const FIX_HINTS = [
  "Fix the checkout removes what saw confirmed from this folder, including installed packages, build output, and the lockfile. The clean-up sits on a new local branch. Past commits stay as they are, and nothing is pushed.",
  "Amending history is a different act. It rewrites the commits that still carry the malicious code and force-updates the branches those commits are on. Fix the checkout does not do that.",
];

export function verdictPage(folder: ChatFolderInput, index: string | number): VerdictPage {
  const notices: { text: string; tone: Tone }[] = [];
  if (folder.held) {
    notices.push({ text: `An update was held (${VERDICT_BADGE[folder.held.verdict]}). The folder was not changed.`, tone: folder.held.verdict === "infected" ? "bad" : "warn" });
  }
  if (folder.unheld) {
    notices.push({ text: unheldSentence(folder.unheldFrom), tone: folder.unheldFrom === "open" ? "warn" : "bad" });
  }
  if (folder.decision) {
    notices.push({ text: folder.decision, tone: "warn" });
  }
  if (folder.cleanup) {
    notices.push(...cleanupLines(folder.cleanup));
  }
  const idle = folder.phase === "idle";
  const actions: ChatButton[] = [];
  let primary: ChatButton | undefined;
  if (folder.phase === "deciding") {
    primary = { act: `decide:${index}`, label: "Open the decision", tone: "primary" };
  } else if (folder.verdict === "infected" && idle) {
    primary = { act: `fix:${index}`, label: "Fix the checkout", tone: "danger" };
  } else if (!folder.verdict && idle) {
    primary = { act: `scan:${index}`, label: "Scan this folder", tone: "primary" };
  }
  if (folder.verdict && idle) {
    actions.push({ act: `scan:${index}`, label: "Scan again", tone: "secondary" });
  }
  if (folder.verdict || folder.phase !== "idle") {
    actions.push({ act: `report:${index}`, label: "Full report", tone: "secondary" });
  }
  if (folder.cleanup) {
    actions.push({ act: `fix-report:${index}`, label: "Fix report", tone: "secondary" });
  }
  const groups = groupFindings(folder.findings, index, PAGE_PLACES);
  const live = folder.checking ? checkingSentence(folder.checkAbout, folder.checkStep) : liveLine(folder);
  const summary = summaryLine(folder.findings);
  const empty = !folder.verdict
    ? idle ? "This folder has not been scanned yet. A scan only reads it." : undefined
    : !folder.findings.length ? "saw found nothing it knows in this folder." : undefined;
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
    hints: primary?.tone === "danger" ? FIX_HINTS : [],
    groups,
    advisories: folder.advisories ?? 0,
    ...(empty ? { empty } : {}),
  };
}

function cleanupLines(cleanup: ChatCleanup): { text: string; tone: Tone }[] {
  const lines: { text: string; tone: Tone }[] = [];
  if (cleanup.branch) {
    lines.push({ text: `The clean-up is on the local branch ${cleanup.branch}.`, tone: "ok" });
  }
  if (cleanup.historyHoldsPayload) {
    lines.push({ text: "That clean-up left the malicious code in git history. Amending history is what rewrites those commits. The checkout fix does not.", tone: "bad" });
  }
  if (cleanup.partial || cleanup.needsYou) {
    lines.push({ text: "Part of the clean-up still needs you. The fix report says what.", tone: "warn" });
  }
  return lines;
}

/** The tab. Every string from a scan is escaped, so it cannot become markup. */
export function renderVerdict(page: VerdictPage, nonce: string): string {
  const path = page.path ? `<p class="path">${text(page.path, 300)}</p>` : "";
  const summary = page.summary ? `<p class="sum">${text(page.summary, 160)}</p>` : "";
  const bar = page.primary || page.actions.length
    ? `<div class="bar">${page.primary ? buttonHtml(page.primary) : ""}${page.actions.map(buttonHtml).join("")}</div>`
    : "";
  const hints = page.hints.map((line) => `<p class="hint">${text(line)}</p>`).join("");
  const notices = page.notices.map((notice) => `<p class="notice ${notice.tone}">${text(notice.text)}</p>`).join("");
  const reasons = page.reasons.length
    ? `<section class="block"><h2>Why</h2><ul class="why">${page.reasons.map((line) => `<li>${text(line)}</li>`).join("")}</ul></section>`
    : "";
  const findings = page.groups.length
    ? `<section class="block"><h2>Findings</h2><ul class="findings">${page.groups.map(groupHtml).join("")}</ul></section>`
    : page.empty ? `<p class="empty">${text(page.empty)}</p>` : "";
  const advisories = page.advisories
    ? `<p class="hint">${page.advisories} ${page.advisories === 1 ? "advisory names a known-vulnerable package" : "advisories name known-vulnerable packages"}. The full report lists them.</p>`
    : "";
  const body = `<main class="verdict ${page.tone}">
    <header class="hero">
      <div class="top">${pillHtml(page.status)}<h1 class="title">${text(page.title, 120)}</h1></div>
      ${path}${liveHtml(page.live)}${summary}${bar}${hints}
    </header>
    ${notices}${reasons}${findings}${advisories}
  </main>`;
  return pageDocument(nonce, body, PAGE_SCRIPT, "editor");
}

function groupHtml(group: ChatFindingGroup): string {
  const count = group.count > 1 ? ` <span class="count">× ${group.count}</span>` : "";
  const more = group.hidden > 0 ? `<span class="more">+${group.hidden} in the full report</span>` : "";
  return `<li>
    <div class="what"><span class="sev ${group.severity}">${group.severity}</span><span>${text(group.what, 300)}${count}</span></div>
    <div class="places">${group.places.map((place) => `<button type="button" class="place" title="${text(place.label, 300)}" data-act="${escapeHtml(place.act)}">${text(place.label, 160)}</button>`).join("")}${more}</div>
  </li>`;
}
