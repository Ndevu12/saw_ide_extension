// The sidebar chat and the editor tab, as data and HTML. No editor API: every VS Code-based IDE hosts the same webview.

import type { Severity } from "../scan/contract";
import type { FolderVerdict } from "../scan/verdict";
import { plain } from "../text";
import { pageDocument } from "./brand";

/** How many kinds of finding a card lists, and how many places under each. The rest stay in the report. */
export const SHOWN_GROUPS = 5;
export const SHOWN_PLACES = 4;

export type ButtonTone = "primary" | "secondary" | "danger";
export type Tone = "neutral" | "ok" | "warn" | "bad";

export interface ChatButton {
  act: string;
  label: string;
  tone: ButtonTone;
}

/** One kind of finding, and the places saw found it. */
export interface ChatFindingGroup {
  what: string;
  severity: Severity;
  count: number;
  places: ChatButton[];
  /** Places not listed, which the report has. */
  hidden: number;
}

/** A line of the machine card: what it is, its state, and the one thing to do about it. */
export interface ChatItem {
  name: string;
  state: string;
  tone: Tone;
  action?: ChatButton;
}

export interface ChatCard {
  badge: string;
  title: string;
  tone: Tone;
  /** Work that is running now, such as a scan's progress. */
  live?: string;
  summary?: string;
  notices?: { text: string; tone: Tone }[];
  paragraphs: string[];
  /** Explanation in a quieter voice. */
  hints?: string[];
  findings?: ChatFindingGroup[];
  /** Findings the card does not list. */
  unlisted?: number;
  items?: ChatItem[];
  /** A primary or danger action is drawn full width. The rest sit in one row. */
  actions: ChatButton[];
}

export interface ChatFindingInput {
  what: string;
  where: string;
  severity: Severity;
  /** The finding's place in the folder's list, which `open:<folder>:<n>` opens. */
  open: number;
}

/** What the last checkout fix left behind, when this window has finished one. */
export interface ChatCleanup {
  branch?: string;
  /** Past commits still carry what the checkout fix removed. */
  historyHoldsPayload: boolean;
  partial: boolean;
  needsYou: boolean;
}

export interface ChatFolderInput {
  name: string;
  phase: "idle" | "scanning" | "fixing" | "deciding";
  progress?: string;
  verdict?: FolderVerdict;
  reasons: string[];
  findings: ChatFindingInput[];
  held?: { verdict: FolderVerdict; reasons: string[] };
  /** Set while saw is checking an update that has not changed the folder yet. */
  checking?: boolean;
  /** The step saw named during that check. */
  checkStep?: string;
  /** An update landing, or the tree already open. The words differ. */
  checkAbout?: "update" | "admission";
  /** A git command this window did not run already changed the folder, or the open folder was not let in. */
  unheld?: boolean;
  /** Which of those two the line should name. */
  unheldFrom?: "command" | "open";
  /** Set while a fix is waiting, naming which act the question belongs to. */
  decision?: string;
  cleanup?: ChatCleanup;
}

export interface ChatMachineInput {
  engine: { phase: "ready" | "installing" | "unavailable"; message?: string; canInstall: boolean };
  auditing: boolean;
  auditProgress?: string;
  auditLabel?: string;
  hooks: "checking" | "installed" | "repair" | "missing" | "unknown";
  hooksDetail?: string;
  /** `saw watch status` is being read. */
  readingWatch?: boolean;
  /** The first line of the last watch report this window read. */
  watchLine?: string;
  /** How the last audit reads: safe, to confirm, or not yet. */
  auditTone?: Tone;
}

const VERDICT_BADGE: Record<FolderVerdict, string> = {
  clean: "clean",
  residue: "residue",
  suspicious: "suspicious",
  incomplete: "could not scan",
  infected: "infected",
};

const VERDICT_TONE: Record<FolderVerdict, ChatCard["tone"]> = {
  clean: "ok",
  residue: "ok",
  suspicious: "warn",
  incomplete: "warn",
  infected: "bad",
};

/** The cards the chat shows, in order. Folder buttons are keyed by that folder's place in `folders`. */
export function chatCards(folders: ChatFolderInput[], machine: ChatMachineInput, extra?: ChatCard): ChatCard[] {
  const cards: ChatCard[] = [];
  if (machine.engine.phase === "installing") {
    cards.push({ badge: "installing", title: "saw", tone: "neutral", live: "Installing saw.", paragraphs: [], actions: [] });
  } else if (machine.engine.phase === "unavailable") {
    cards.push({
      badge: "unavailable",
      title: "saw",
      tone: "warn",
      paragraphs: [machine.engine.message || "saw cannot run."],
      actions: machine.engine.canInstall ? [{ act: "install", label: "Install saw", tone: "primary" }] : [],
    });
  }
  if (folders.length === 0) {
    cards.push({
      badge: "no folder",
      title: "Nothing is open",
      tone: "neutral",
      paragraphs: ["Open a folder and saw will report it here."],
      actions: [],
    });
  }
  folders.forEach((folder, index) => cards.push(folderCard(folder, index)));
  if (extra) {
    cards.push(extra);
  }
  cards.push(machineCard(machine));
  return cards;
}

const OPEN_UNHELD = "saw has no record of letting this commit in. The folder was left as it is.";

/** Chat names the git command saw missed. An agent hears that a change arrived without a check. */
const MISSED_COMMAND = {
  chat: "A git command saw did not run changed this folder. That change was not held before it landed.",
  agent: "A change reached this folder that saw did not let in. It was not held before it landed.",
} as const;

/** What Chat or an agent says when a folder changed without a check, or was already not a commit saw let in. */
export function unheldSentence(from: "command" | "open" | undefined, audience: keyof typeof MISSED_COMMAND = "chat"): string {
  if (from === "open") {
    return OPEN_UNHELD;
  }
  return MISSED_COMMAND[audience];
}

/** What Chat, the status bar, and an agent say while a check runs. An open folder is not an update. */
export function checkingSentence(about: "update" | "admission" | undefined, step: string | undefined): string {
  if (about === "admission") {
    return "saw is checking whether it let this folder in. The folder has not changed.";
  }
  return step
    ? `saw is checking this update: ${step}. The folder has not changed.`
    : "saw is checking this update. The folder has not changed.";
}

/** The short form of that check, for a badge or a status item. */
export function checkingBadge(about: "update" | "admission" | undefined, step: string | undefined): string {
  if (about === "admission") {
    return "checking this folder";
  }
  return step ? `checking: ${step}` : "checking this update";
}

const SEVERITY_ORDER: readonly Severity[] = ["critical", "high", "medium", "low"];

/** saw's progress names the folder's path, which the card's title already says. */
export function progressLine(progress: string): string {
  return progress.replace(/^Scanning\s+\S.*?\s+—\s+/, "Scanning: ");
}

/** Findings with the same description become one line, the most severe first. */
export function groupFindings(findings: readonly ChatFindingInput[], index: string | number): { groups: ChatFindingGroup[]; unlisted: number } {
  const byWhat = new Map<string, ChatFindingInput[]>();
  for (const finding of findings) {
    const same = byWhat.get(finding.what);
    if (same) {
      same.push(finding);
    } else {
      byWhat.set(finding.what, [finding]);
    }
  }
  const rank = (severity: Severity) => SEVERITY_ORDER.indexOf(severity);
  const groups = [...byWhat.values()]
    .map((same) => ({ same, severity: same.map((finding) => finding.severity).sort((a, b) => rank(a) - rank(b))[0] ?? "low" }))
    .sort((a, b) => rank(a.severity) - rank(b.severity) || b.same.length - a.same.length);
  const shown = groups.slice(0, SHOWN_GROUPS);
  const unlisted = groups.slice(SHOWN_GROUPS).reduce((sum, group) => sum + group.same.length, 0);
  return {
    groups: shown.map(({ same, severity }) => ({
      what: sentence((same[0] as ChatFindingInput).what),
      severity,
      count: same.length,
      places: same.slice(0, SHOWN_PLACES).map((finding) => ({ act: `open:${index}:${finding.open}`, label: finding.where, tone: "secondary" as const })),
      hidden: Math.max(0, same.length - SHOWN_PLACES),
    })),
    unlisted,
  };
}

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function summaryLine(findings: readonly ChatFindingInput[]): string | undefined {
  if (!findings.length) {
    return undefined;
  }
  const counts = SEVERITY_ORDER.map((severity) => [severity, findings.filter((finding) => finding.severity === severity).length] as const)
    .filter(([, count]) => count > 0)
    .map(([severity, count]) => `${count} ${severity}`);
  return `${findings.length} ${findings.length === 1 ? "finding" : "findings"} · ${counts.join(" · ")}`;
}

function folderCard(folder: ChatFolderInput, index: string | number): ChatCard {
  const { groups, unlisted } = groupFindings(folder.findings, index);
  const notices: { text: string; tone: Tone }[] = [];
  const paragraphs = [...folder.reasons];
  const hints: string[] = [];
  if (folder.held) {
    notices.push({ text: `An update was held (${VERDICT_BADGE[folder.held.verdict]}). The folder was not changed.`, tone: folder.held.verdict === "infected" ? "bad" : "warn" });
    paragraphs.push(...folder.held.reasons);
  }
  if (folder.unheld) {
    notices.push({ text: unheldSentence(folder.unheldFrom), tone: folder.unheldFrom === "open" ? "warn" : "bad" });
  }
  if (folder.decision) {
    notices.push({ text: folder.decision, tone: "warn" });
  }
  if (folder.phase === "idle" && !folder.verdict) {
    paragraphs.unshift("This folder has not been scanned yet. A scan only reads it.");
  }
  if (folder.verdict === "clean" && !folder.findings.length && !paragraphs.length) {
    paragraphs.push("saw found nothing it knows in this folder.");
  }
  if (folder.verdict === "infected" && folder.phase === "idle") {
    hints.push(
      "Fix the checkout removes what saw confirmed from this folder, including installed packages, build output, and the lockfile. The clean-up sits on a new local branch. Past commits stay as they are, and nothing is pushed.",
      "Amending history is a different act. It rewrites the commits that still carry the malicious code and force-updates the branches those commits are on. Fix the checkout does not do that.",
    );
  }
  if (folder.cleanup) {
    notices.push(...cleanupLines(folder.cleanup));
  }
  const live = liveLine(folder);
  const summary = summaryLine(folder.findings);
  return {
    badge: folder.verdict ? VERDICT_BADGE[folder.verdict] : folder.phase === "scanning" ? "scanning" : "not scanned",
    title: folder.name,
    tone: folder.verdict ? VERDICT_TONE[folder.verdict] : "neutral",
    ...(live ? { live } : {}),
    ...(summary ? { summary } : {}),
    notices,
    paragraphs,
    hints,
    findings: groups,
    unlisted,
    actions: folderActions(folder, index),
  };
}

/** What is running now. A verdict badge stays the last result while the next scan runs. */
function liveLine(folder: ChatFolderInput): string | undefined {
  if (folder.checking) {
    return checkingSentence(folder.checkAbout, folder.checkStep);
  }
  switch (folder.phase) {
    case "scanning":
      return folder.progress ? progressLine(folder.progress) : "Scanning.";
    case "fixing":
      return "Fixing the checkout.";
    case "deciding":
      return "A fix is waiting for you.";
    case "idle":
      return undefined;
  }
}

function folderActions(folder: ChatFolderInput, index: string | number): ChatButton[] {
  const actions: ChatButton[] = [];
  if (folder.phase === "deciding") {
    actions.push({ act: `decide:${index}`, label: "Open the decision", tone: "primary" });
  } else if (folder.verdict === "infected" && folder.phase === "idle") {
    actions.push({ act: `fix:${index}`, label: "Fix the checkout", tone: "danger" });
  }
  const review = folder.verdict === "suspicious" || folder.verdict === "incomplete";
  if (folder.verdict) {
    actions.push({ act: `report:${index}`, label: "Open the scan report", tone: review && !actions.length ? "primary" : "secondary" });
  }
  if (folder.phase !== "scanning") {
    actions.push({ act: `scan:${index}`, label: folder.verdict ? "Scan again" : "Scan this folder", tone: folder.verdict ? "secondary" : "primary" });
  }
  actions.push({ act: `verdict:${index}`, label: "Open verdict", tone: "secondary" });
  if (folder.cleanup) {
    actions.push({ act: `fix-report:${index}`, label: "Open the fix report", tone: "secondary" });
  }
  return actions;
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

function auditItem(machine: ChatMachineInput): ChatItem {
  if (machine.auditing) {
    return { name: "Credentials", state: machine.auditProgress ? `Auditing: ${machine.auditProgress}` : "Auditing this machine.", tone: "neutral" };
  }
  if (machine.auditLabel) {
    return { name: "Credentials", state: `Changing them: ${machine.auditLabel}.`, tone: machine.auditTone ?? "neutral", action: { act: "audit", label: "Audit again", tone: "secondary" } };
  }
  return { name: "Credentials", state: "Not audited yet. Audit before you change a password or token.", tone: "warn", action: { act: "audit", label: "Audit", tone: "primary" } };
}

function hooksItem(machine: ChatMachineInput): ChatItem {
  const name = "Scan-on-clone hooks";
  switch (machine.hooks) {
    case "checking":
      return { name, state: "Checking.", tone: "neutral" };
    case "installed":
      return { name, state: machine.hooksDetail ? `In place: ${machine.hooksDetail}.` : "In place.", tone: "ok" };
    case "repair":
      return { name, state: "Need repair. A clone, pull, or branch switch may not be scanned.", tone: "warn", action: { act: "hooks:repair", label: "Repair", tone: "primary" } };
    case "missing":
      return { name, state: "Not installed. A clone, pull, or branch switch is scanned when they are.", tone: "warn", action: { act: "hooks:install", label: "Install", tone: "primary" } };
    case "unknown":
      return { name, state: machine.hooksDetail || "saw could not say whether they are installed.", tone: "warn", action: { act: "hooks:check", label: "Check", tone: "secondary" } };
  }
}

function watchItem(machine: ChatMachineInput): ChatItem {
  const action: ChatButton = { act: "watch", label: "Open report", tone: "secondary" };
  if (machine.readingWatch) {
    return { name: "saw watch", state: "Reading what saw watch reported.", tone: "neutral" };
  }
  if (machine.watchLine) {
    return { name: "saw watch", state: machine.watchLine, tone: "neutral", action };
  }
  return { name: "saw watch", state: "Not read yet. It says whether the watcher is in place and what happened since the last report.", tone: "neutral", action };
}

function machineCard(machine: ChatMachineInput): ChatCard {
  const items = [auditItem(machine), hooksItem(machine), watchItem(machine)];
  const open = items.filter((item) => item.tone === "warn" || item.tone === "bad").length;
  const tone: Tone = items.some((item) => item.tone === "bad") ? "bad" : open ? "warn" : items.every((item) => item.tone === "ok" || item.name === "saw watch") ? "ok" : "neutral";
  return {
    badge: machine.auditing ? "auditing" : open ? `${open} to do` : "in order",
    title: "This machine",
    tone,
    paragraphs: [],
    hints: ["An audit reads this machine. It does not change a credential."],
    items,
    actions: [{ act: "docs", label: "What each verdict means", tone: "secondary" }],
  };
}

const CHAT_SCRIPT = `
  const vscode = acquireVsCodeApi();
  document.body.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("button[data-act]") : null;
    if (!button) return;
    vscode.postMessage({ act: button.getAttribute("data-act") });
  });
`;

/** The chat page. Every string from a scan is escaped, so it cannot become markup. */
export function renderChat(cards: ChatCard[], nonce: string, place: "side" | "editor" = "side"): string {
  const mark = place === "editor"
    ? `<header class="mark"><p class="word">stayAwakeBot</p><p class="tag">the sentinel saw the worm</p></header>`
    : "";
  const body = `${mark}<div class="thread">${cards.map((card) => cardHtml(card)).join("")}</div>`;
  return pageDocument(nonce, body, CHAT_SCRIPT, place);
}

function text(value: string, max = 500): string {
  return escapeHtml(plain(value, max));
}

function findingHtml(group: ChatFindingGroup, report: string | undefined): string {
  const count = group.count > 1 ? ` <span class="count">× ${group.count}</span>` : "";
  const more = group.hidden > 0 && report
    ? `<button type="button" class="more" data-act="${escapeHtml(report)}">+${group.hidden} in the report</button>`
    : "";
  return `<li>
    <div class="what"><span class="sev ${group.severity}">${group.severity}</span><span>${text(group.what, 300)}${count}</span></div>
    <div class="places">${group.places.map((place) => `<button type="button" class="place" title="${text(place.label, 300)}" data-act="${escapeHtml(place.act)}">${text(place.label, 160)}</button>`).join("")}${more}</div>
  </li>`;
}

function itemHtml(item: ChatItem): string {
  return `<div class="item">
    <span class="name">${text(item.name, 60)}</span>
    <span class="state"><span class="dot ${item.tone}"></span><span>${text(item.state, 300)}</span></span>
    ${item.action ? buttonHtml(item.action) : ""}
  </div>`;
}

function cardHtml(card: ChatCard): string {
  const report = card.actions.find((button) => button.act.startsWith("report:"))?.act;
  const live = card.live ? `<p class="live"><span class="spin" aria-hidden="true"></span><span>${text(card.live, 300)}</span></p>` : "";
  const summary = card.summary ? `<p class="summary">${text(card.summary, 120)}</p>` : "";
  const notices = (card.notices ?? []).map((notice) => `<p class="notice ${notice.tone}">${text(notice.text)}</p>`).join("");
  const paragraphs = card.paragraphs.map((line) => `<p>${text(line)}</p>`).join("");
  const findings = card.findings?.length ? `<ul class="findings">${card.findings.map((group) => findingHtml(group, report)).join("")}</ul>` : "";
  const unlisted = card.unlisted ? `<p class="hint">${card.unlisted} more ${card.unlisted === 1 ? "finding is" : "findings are"} in the report.</p>` : "";
  const items = card.items?.length ? `<div class="items">${card.items.map(itemHtml).join("")}</div>` : "";
  const hints = (card.hints ?? []).map((line) => `<p class="hint">${text(line)}</p>`).join("");
  const main = card.actions.filter((button) => button.tone !== "secondary");
  const links = card.actions.filter((button) => button.tone === "secondary");
  const actions = `${main.length ? `<div class="main">${main.map(buttonHtml).join("")}</div>` : ""}${links.length ? `<div class="links">${links.map(buttonHtml).join("")}</div>` : ""}`;
  return `<article>
    <section class="card ${card.tone}">
      <div class="head"><span class="badge">${text(card.badge, 40)}</span><h2 class="title">${text(card.title, 120)}</h2></div>
      ${live}${summary}${notices}${paragraphs}${findings}${unlisted}${items}${hints}${actions}
    </section>
  </article>`;
}

function buttonHtml(button: ChatButton): string {
  return `<button type="button" class="${button.tone}" data-act="${escapeHtml(button.act)}">${text(button.label, 200)}</button>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}
