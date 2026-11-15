// The sidebar chat, as data and HTML. No editor API: every VS Code-based IDE hosts the same webview.
// Chat says where each folder stands and what to do next. The verdict itself opens in an editor tab.

import type { Severity } from "../scan/contract";
import type { FolderVerdict } from "../scan/verdict";
import { plain } from "../text";
import { pageDocument } from "./brand";

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
  /** Places not listed, which the full report has. */
  hidden: number;
}

/** A card in Chat: a status, one line of what matters, the next step, and where to read more. */
export interface ChatCard {
  title: string;
  status?: string;
  tone: Tone;
  /** Work that is running now, such as a scan's progress. */
  live?: string;
  summary?: string;
  /** The one notice that matters most. The verdict tab has the rest. */
  notice?: { text: string; tone: Tone };
  text?: string;
  primary?: ChatButton;
  /** What the primary button does not do, in a few words. */
  note?: string;
  links: ChatButton[];
}

/** A line of the machine section: what it is, its state, the report it opens, and the one thing to do about it. */
export interface ChatItem {
  name: string;
  state: string;
  tone: Tone;
  open?: string;
  action?: ChatButton;
}

export interface ChatMachine {
  status: string;
  tone: Tone;
  items: ChatItem[];
}

export interface ChatPage {
  cards: ChatCard[];
  machine: ChatMachine;
  nav: ChatButton[];
}

export interface ChatFindingInput {
  what: string;
  where: string;
  severity: Severity;
  /** The finding's place in the folder's list, which `open:<folder>:<n>` opens. */
  open: number;
}

/** What the last files fix (`saw fix`) left behind, when this window has finished one. */
export interface ChatCleanup {
  branch?: string;
  /** Past commits still carry what the files fix removed. */
  historyHoldsPayload: boolean;
  partial: boolean;
  needsYou: boolean;
}

export interface ChatFolderInput {
  name: string;
  /** Shown on the verdict tab, under the name. */
  path?: string;
  phase: "idle" | "scanning" | "fixing" | "deciding";
  /** Which fix is running or waiting: `saw fix` on the files, or `saw fix amend` on git history. */
  treating?: "files" | "history";
  progress?: string;
  verdict?: FolderVerdict;
  reasons: string[];
  findings: ChatFindingInput[];
  /** Known-vulnerable packages. The full report lists them. */
  advisories?: number;
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
  /** The last git history fix (`saw fix amend`) this window ran. */
  history?: "running" | "done" | "review" | "failed";
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

export const VERDICT_BADGE: Record<FolderVerdict, string> = {
  clean: "clean",
  residue: "traces left",
  suspicious: "suspicious",
  incomplete: "could not scan",
  infected: "infected",
};

export const VERDICT_TONE: Record<FolderVerdict, Tone> = {
  clean: "ok",
  residue: "ok",
  suspicious: "warn",
  incomplete: "warn",
  infected: "bad",
};

const TONE_RANK: Record<Tone, number> = { bad: 0, warn: 1, ok: 2, neutral: 3 };

/** What Chat shows: a card per folder, the machine, and where the reports are. Folder buttons are keyed by that folder's place in `folders`. */
export function chatPage(folders: ChatFolderInput[], machine: ChatMachineInput, extra?: ChatCard): ChatPage {
  const cards: ChatCard[] = [];
  if (machine.engine.phase === "installing") {
    cards.push({ title: "Installing saw", tone: "neutral", live: "Installing. Folders are scanned when it is ready.", links: [{ act: "log", label: "Show log", tone: "secondary" }] });
  } else if (machine.engine.phase === "unavailable") {
    cards.push({
      title: "saw cannot run",
      tone: "warn",
      text: machine.engine.message || "No scan can run until saw is installed.",
      ...(machine.engine.canInstall ? { primary: { act: "install", label: "Install saw", tone: "primary" } } : {}),
      links: [{ act: "log", label: "Show log", tone: "secondary" }],
    });
  }
  if (folders.length === 0) {
    cards.push({ title: "No folder is open", tone: "neutral", text: "Open a folder to scan it.", links: [] });
  }
  folders.forEach((folder, index) => cards.push(folderCard(folder, index)));
  if (extra) {
    cards.push(extra);
  }
  return {
    cards,
    machine: machineSection(machine),
    nav: [
      { act: "reports", label: "All details", tone: "secondary" },
      { act: "docs", label: "What these results mean", tone: "secondary" },
    ],
  };
}

const OPEN_UNHELD = "saw didn't check this version of the folder before it arrived. Nothing was changed.";

/** Chat names the git command saw missed. An agent hears that a change arrived without a check. */
const MISSED_COMMAND = {
  chat: "A git command changed this folder before saw could check the change.",
  agent: "A change reached this folder that saw did not let in. It was not held before it landed.",
} as const;

/** What the verdict tab or an agent says when a folder changed without a check, or was already not a commit saw let in. */
export function unheldSentence(from: "command" | "open" | undefined, audience: keyof typeof MISSED_COMMAND = "chat"): string {
  if (from === "open") {
    return OPEN_UNHELD;
  }
  return MISSED_COMMAND[audience];
}

/** What the verdict tab, the status bar, and an agent say while a check runs. An open folder is not an update. */
export function checkingSentence(about: "update" | "admission" | undefined, step: string | undefined): string {
  if (about === "admission") {
    return "saw is checking this version of the folder. Nothing has changed.";
  }
  return step
    ? `saw is checking this update: ${step}. Nothing has changed yet.`
    : "saw is checking this update. Nothing has changed yet.";
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
export function groupFindings(findings: readonly ChatFindingInput[], index: string | number, placesShown = Number.POSITIVE_INFINITY): ChatFindingGroup[] {
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
  return [...byWhat.values()]
    .map((same) => ({ same, severity: same.map((finding) => finding.severity).sort((a, b) => rank(a) - rank(b))[0] ?? "low" }))
    .sort((a, b) => rank(a.severity) - rank(b.severity) || b.same.length - a.same.length)
    .map(({ same, severity }) => ({
      what: sentence((same[0] as ChatFindingInput).what),
      severity,
      count: same.length,
      places: same.slice(0, placesShown).map((finding) => ({ act: `open:${index}:${finding.open}`, label: finding.where, tone: "secondary" as const })),
      hidden: Math.max(0, same.length - placesShown),
    }));
}

export function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "12 findings · 1 high · 10 medium". */
export function summaryLine(findings: readonly ChatFindingInput[]): string | undefined {
  if (!findings.length) {
    return undefined;
  }
  const counts = SEVERITY_ORDER.map((severity) => [severity, findings.filter((finding) => finding.severity === severity).length] as const)
    .filter(([, count]) => count > 0)
    .map(([severity, count]) => `${count} ${severity}`);
  return `${findings.length} ${findings.length === 1 ? "finding" : "findings"} · ${counts.join(" · ")}`;
}

export function folderStatus(folder: ChatFolderInput): string {
  return folder.verdict ? VERDICT_BADGE[folder.verdict] : folder.phase === "scanning" ? "scanning" : "not scanned";
}

/** What is running now. A verdict stays the last result while the next scan runs. */
export function liveLine(folder: ChatFolderInput): string | undefined {
  if (folder.checking) {
    return sentence(checkingBadge(folder.checkAbout, folder.checkStep));
  }
  switch (folder.phase) {
    case "scanning":
      return folder.progress ? progressLine(folder.progress) : "Scanning";
    case "fixing":
      return `Fixing infection in ${treatmentName(folder)}`;
    case "deciding":
      return `Fixing infection in ${treatmentName(folder)}: waiting for your choice`;
    case "idle":
      return undefined;
  }
}

function treatmentName(folder: ChatFolderInput): string {
  return folder.treating === "history" ? "git history" : "files";
}

/** The files fix left the infection in past commits, and no git history fix has removed it. */
export function historyStillInfected(folder: ChatFolderInput): boolean {
  return folder.cleanup?.historyHoldsPayload === true && folder.history !== "done";
}

/** The short form of each thing the verdict tab explains, the most serious first. */
function folderNotice(folder: ChatFolderInput): { text: string; tone: Tone } | undefined {
  const notices: { text: string; tone: Tone }[] = [];
  if (folder.held) {
    notices.push({ text: `An update was stopped (${VERDICT_BADGE[folder.held.verdict]}). The folder is unchanged.`, tone: folder.held.verdict === "infected" ? "bad" : "warn" });
  }
  const settled = folder.verdict === "clean" || folder.verdict === "infected";
  if (folder.unheld && folder.unheldFrom !== "open") {
    notices.push({ text: "A git command changed this folder without a check.", tone: "bad" });
  } else if (folder.unheld && !settled) {
    notices.push({ text: "This version arrived without a check.", tone: "warn" });
  }
  const cleanup = folder.cleanup;
  if (historyStillInfected(folder)) {
    notices.push({ text: "Git history still holds the infection.", tone: "bad" });
  }
  if (cleanup && (cleanup.partial || cleanup.needsYou)) {
    notices.push({ text: "Part of the files fix still needs you.", tone: "warn" });
  }
  if (cleanup?.branch) {
    notices.push({ text: `The fixed files are on ${cleanup.branch}.`, tone: "ok" });
  }
  if (folder.history === "review") {
    notices.push({ text: "The git history fix needs you.", tone: "warn" });
  } else if (folder.history === "failed") {
    notices.push({ text: "The git history fix did not finish.", tone: "warn" });
  } else if (folder.history === "done") {
    notices.push({ text: "Git history fixed. Everyone with a clone must reset to the new branches.", tone: "ok" });
  }
  return notices.sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone])[0];
}

function folderSummary(folder: ChatFolderInput): string | undefined {
  const counted = summaryLine(folder.findings);
  if (counted) {
    return counted;
  }
  if (!folder.verdict) {
    return folder.phase === "idle" ? "Not scanned yet. A scan only reads the folder." : undefined;
  }
  if (folder.verdict === "incomplete") {
    return plain(folder.reasons[0] ?? "The scan did not finish.", 140);
  }
  return "Nothing harmful found.";
}

export const FIX_FILES = (index: string | number): ChatButton => ({ act: `fix:${index}`, label: "Fix infection in files", tone: "danger" });
export const FIX_HISTORY = (index: string | number): ChatButton => ({ act: `amend:${index}`, label: "Fix infection in git history…", tone: "danger" });
export const FIX_FILES_NOTE = "Runs saw fix. Nothing is pushed, and past commits are not changed.";
export const FIX_HISTORY_NOTE = "Runs saw fix amend. Rewrites past commits and force-pushes their branches.";

const VIEW = (index: string | number): ChatButton => ({ act: `verdict:${index}`, label: "See results", tone: "secondary" });
const RESCAN = (index: string | number): ChatButton => ({ act: `scan:${index}`, label: "Scan again", tone: "secondary" });

/** The next step, as one button, and the rest as links. */
function folderSteps(folder: ChatFolderInput, index: string | number): Pick<ChatCard, "primary" | "note" | "links"> {
  const busy = folder.phase !== "idle";
  const links: ChatButton[] = [];
  let primary: ChatButton | undefined;
  if (folder.phase === "deciding") {
    primary = { act: `decide:${index}`, label: "Choose what to keep", tone: "primary" };
    links.push(VIEW(index));
  } else if (!folder.verdict) {
    if (!busy) {
      primary = { act: `scan:${index}`, label: "Scan this folder", tone: "primary" };
    }
  } else if (historyStillInfected(folder) && !busy) {
    primary = FIX_HISTORY(index);
    links.push(VIEW(index), RESCAN(index));
  } else if (folder.verdict === "infected" && !busy) {
    primary = FIX_FILES(index);
    links.push(VIEW(index), RESCAN(index));
  } else if ((folder.verdict === "suspicious" || folder.verdict === "incomplete") && !busy) {
    primary = { act: `verdict:${index}`, label: "See what was found", tone: "primary" };
    links.push(RESCAN(index));
  } else {
    links.push(VIEW(index));
    if (!busy) {
      links.push(RESCAN(index));
    }
  }
  if (folder.cleanup) {
    links.push({ act: `fix-report:${index}`, label: "Files fix details", tone: "secondary" });
  }
  if (folder.history) {
    links.push({ act: `amend-report:${index}`, label: "Git history fix details", tone: "secondary" });
  }
  const note = primary?.act.startsWith("amend:") ? FIX_HISTORY_NOTE : primary?.act.startsWith("fix:") ? FIX_FILES_NOTE : undefined;
  return { ...(primary ? { primary } : {}), ...(note ? { note } : {}), links };
}

function folderCard(folder: ChatFolderInput, index: string | number): ChatCard {
  const live = liveLine(folder);
  const summary = folderSummary(folder);
  const notice = folderNotice(folder);
  return {
    title: folder.name,
    status: folderStatus(folder),
    tone: folder.verdict ? VERDICT_TONE[folder.verdict] : "neutral",
    ...(live ? { live } : {}),
    ...(summary ? { summary } : {}),
    ...(notice ? { notice } : {}),
    ...folderSteps(folder, index),
  };
}

function auditItem(machine: ChatMachineInput): ChatItem {
  const name = "Before you change passwords";
  const open = "machine:audit";
  if (machine.auditing) {
    return { name, state: machine.auditProgress ? `Checking: ${machine.auditProgress}` : "Checking this machine", tone: "neutral", open };
  }
  if (machine.auditLabel) {
    const tone = machine.auditTone ?? "neutral";
    return { name, state: sentence(machine.auditLabel), tone, open, ...(tone === "ok" ? {} : { action: { act: "audit", label: "Check again", tone: "secondary" } }) };
  }
  return { name, state: "Check this machine first", tone: "warn", action: { act: "audit", label: "Check", tone: "primary" } };
}

function hooksItem(machine: ChatMachineInput): ChatItem {
  const name = "Check repos on clone and pull";
  const open = "machine:hooks";
  switch (machine.hooks) {
    case "checking":
      return { name, state: "Checking", tone: "neutral" };
    case "installed":
      return { name, state: "On", tone: "ok", open };
    case "repair":
      return { name, state: "Needs repair", tone: "warn", open, action: { act: "hooks:repair", label: "Repair", tone: "primary" } };
    case "missing":
      return { name, state: "Off", tone: "warn", open, action: { act: "hooks:install", label: "Turn on", tone: "primary" } };
    case "unknown":
      return { name, state: "Could not check", tone: "warn", open, action: { act: "hooks:check", label: "Check", tone: "secondary" } };
  }
}

function watchItem(machine: ChatMachineInput): ChatItem {
  const name = "Background checks";
  if (machine.readingWatch) {
    return { name, state: "Reading the latest", tone: "neutral" };
  }
  return { name, state: machine.watchLine ? plain(machine.watchLine, 90) : "Open to see the latest", tone: "neutral", open: "watch" };
}

function machineSection(machine: ChatMachineInput): ChatMachine {
  const items = [auditItem(machine), hooksItem(machine), watchItem(machine)];
  const todo = items.filter((item) => item.tone === "warn" || item.tone === "bad").length;
  const tone: Tone = items.some((item) => item.tone === "bad") ? "bad" : todo ? "warn" : "ok";
  return { status: machine.auditing ? "checking" : todo ? `${todo} to do` : "all good", tone, items };
}

/** Clicks become messages, and the page keeps its scroll when the extension redraws it. */
export const PAGE_SCRIPT = `
  const vscode = acquireVsCodeApi();
  const kept = vscode.getState();
  if (kept && typeof kept.y === "number") window.scrollTo(0, kept.y);
  window.addEventListener("scroll", () => vscode.setState({ y: window.scrollY }), { passive: true });
  document.body.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("button[data-act]") : null;
    if (!button) return;
    vscode.postMessage({ act: button.getAttribute("data-act") });
  });
`;

/** The chat page. Every string from a scan is escaped, so it cannot become markup. */
export function renderChat(page: ChatPage, nonce: string): string {
  const body = `<main class="chat">
    ${page.cards.map(cardHtml).join("")}
    ${machineHtml(page.machine)}
    <nav class="foot">${page.nav.map(linkHtml).join("")}</nav>
  </main>`;
  return pageDocument(nonce, body, PAGE_SCRIPT, "side");
}

export function text(value: string, max = 500): string {
  return escapeHtml(plain(value, max));
}

export function pillHtml(status: string): string {
  return `<span class="pill">${text(status, 40)}</span>`;
}

export function liveHtml(live: string | undefined): string {
  return live ? `<p class="live"><span class="spin" aria-hidden="true"></span><span>${text(live, 300)}</span></p>` : "";
}

function cardHtml(card: ChatCard): string {
  const status = card.status ? pillHtml(card.status) : "";
  const summary = card.summary ? `<p class="sum">${text(card.summary, 160)}</p>` : "";
  const notice = card.notice ? `<p class="notice ${card.notice.tone}">${text(card.notice.text, 200)}</p>` : "";
  const body = card.text ? `<p class="body">${text(card.text, 400)}</p>` : "";
  const note = card.note ? `<p class="note">${text(card.note, 120)}</p>` : "";
  const primary = card.primary ? `<div class="cta">${buttonHtml(card.primary)}${note}</div>` : "";
  const links = card.links.length ? `<nav class="links">${card.links.map(linkHtml).join("")}</nav>` : "";
  return `<article class="card ${card.tone}">
    <header class="top"><h2 class="title" title="${text(card.title, 200)}">${text(card.title, 120)}</h2>${status}</header>
    ${liveHtml(card.live)}${summary}${notice}${body}${primary}${links}
  </article>`;
}

function machineHtml(machine: ChatMachine): string {
  return `<section class="machine ${machine.tone}">
    <header class="top"><h2 class="title">This machine</h2>${pillHtml(machine.status)}</header>
    <ul class="items">${machine.items.map(itemHtml).join("")}</ul>
  </section>`;
}

function itemHtml(item: ChatItem): string {
  const inner = `<span class="dot ${item.tone}"></span><span class="name">${text(item.name, 60)}</span><span class="state">${text(item.state, 120)}</span>`;
  const row = item.open
    ? `<button type="button" class="row" data-act="${escapeHtml(item.open)}" title="Open the report">${inner}</button>`
    : `<div class="row">${inner}</div>`;
  const action = item.action ? `<button type="button" class="small ${item.action.tone}" data-act="${escapeHtml(item.action.act)}">${text(item.action.label, 40)}</button>` : "";
  return `<li class="item">${row}${action}</li>`;
}

export function buttonHtml(button: ChatButton): string {
  return `<button type="button" class="${button.tone}" data-act="${escapeHtml(button.act)}">${text(button.label, 200)}</button>`;
}

function linkHtml(button: ChatButton): string {
  return `<button type="button" class="link" data-act="${escapeHtml(button.act)}">${text(button.label, 80)}</button>`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}
