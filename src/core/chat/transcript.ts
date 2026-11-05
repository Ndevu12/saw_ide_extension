// The sidebar chat, as data and HTML. No editor API: every VS Code-based IDE hosts the same webview.

import { plain } from "../text";
import type { FolderVerdict } from "../scan/verdict";

/** How many findings a card lists. The rest stay in the report. */
export const SHOWN_FINDINGS = 6;

export type ButtonTone = "primary" | "secondary" | "danger";

export interface ChatButton {
  act: string;
  label: string;
  tone: ButtonTone;
}

export interface ChatCard {
  badge: string;
  title: string;
  tone: "neutral" | "ok" | "warn" | "bad";
  paragraphs: string[];
  rows: ChatButton[];
  actions: ChatButton[];
}

export interface ChatFindingInput {
  label: string;
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
    cards.push({ badge: "installing", title: "saw", tone: "neutral", paragraphs: ["saw is being installed."], rows: [], actions: [] });
  } else if (machine.engine.phase === "unavailable") {
    cards.push({
      badge: "unavailable",
      title: "saw",
      tone: "warn",
      paragraphs: [machine.engine.message || "saw cannot run."],
      rows: [],
      actions: machine.engine.canInstall ? [{ act: "install", label: "Install saw", tone: "primary" }] : [],
    });
  }
  if (folders.length === 0) {
    cards.push({
      badge: "no folder",
      title: "Nothing is open",
      tone: "neutral",
      paragraphs: ["Open a folder and saw will report it here."],
      rows: [],
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

/** What Chat says when a folder changed without a check, or was already not a commit saw let in. */
export function unheldSentence(from: "command" | "open" | undefined): string {
  if (from === "open") {
    return "This folder is not a commit saw let in, and it was not put back.";
  }
  return "A git command saw did not run changed this folder. That change was not held before it landed.";
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

function folderCard(folder: ChatFolderInput, index: string | number): ChatCard {
  const shown = folder.findings.slice(0, SHOWN_FINDINGS);
  const more = folder.findings.length - shown.length;
  const paragraphs = [...folder.reasons];
  if (folder.checking) {
    paragraphs.unshift(checkingSentence(folder.checkAbout, folder.checkStep));
  }
  if (folder.held) {
    paragraphs.push(`An update was held (${VERDICT_BADGE[folder.held.verdict]}). The folder was not changed.`);
    paragraphs.push(...folder.held.reasons);
  }
  if (folder.unheld) {
    paragraphs.push(unheldSentence(folder.unheldFrom));
  }
  if (folder.phase === "idle" && !folder.verdict) {
    paragraphs.unshift("This folder has not been scanned yet. A scan only reads it.");
  }
  if (folder.decision) {
    paragraphs.push(folder.decision);
  }
  if (folder.verdict === "infected" && folder.phase === "idle") {
    paragraphs.push(
      "Fix the checkout removes what saw confirmed from this folder, including installed packages, build output, and the lockfile. The clean-up sits on a new local branch. Past commits stay as they are, and nothing is pushed.",
      "Amending history is a different act. It rewrites the commits that still carry the malicious code and force-updates the branches those commits are on. Fix the checkout does not do that.",
    );
  }
  if (folder.cleanup) {
    paragraphs.push(...cleanupLines(folder.cleanup));
  }
  if (more > 0) {
    paragraphs.push(`${more} more ${more === 1 ? "finding is" : "findings are"} in the report.`);
  }
  return {
    badge: badge(folder),
    title: folder.name,
    tone: folder.verdict ? VERDICT_TONE[folder.verdict] : "neutral",
    paragraphs,
    rows: shown.map((finding, row) => ({ act: `open:${index}:${row}`, label: finding.label, tone: "secondary" as const })),
    actions: folderActions(folder, index),
  };
}

function badge(folder: ChatFolderInput): string {
  if (folder.checking) {
    return checkingBadge(folder.checkAbout, folder.checkStep);
  }
  if (folder.phase === "scanning") {
    return folder.progress ? `scanning: ${folder.progress}` : "scanning";
  }
  if (folder.phase === "fixing") {
    return "fixing";
  }
  if (folder.phase === "deciding") {
    return "waiting for you";
  }
  return folder.verdict ? VERDICT_BADGE[folder.verdict] : "not scanned";
}

function folderActions(folder: ChatFolderInput, index: string | number): ChatButton[] {
  const actions: ChatButton[] = [];
  if (folder.phase === "deciding") {
    actions.push({ act: `decide:${index}`, label: "Show the decision", tone: "primary" });
  } else if (folder.verdict === "infected" && folder.phase === "idle") {
    actions.push({ act: `fix:${index}`, label: "Fix the checkout", tone: "danger" });
  }
  if (folder.phase !== "scanning") {
    actions.push({ act: `scan:${index}`, label: folder.verdict ? "Scan again" : "Scan this folder", tone: folder.verdict ? "secondary" : "primary" });
  }
  if (folder.verdict) {
    actions.push({ act: `report:${index}`, label: "Open the scan report", tone: "secondary" });
  }
  if (folder.cleanup) {
    actions.push({ act: `fix-report:${index}`, label: "Open the fix report", tone: "secondary" });
  }
  return actions;
}

function cleanupLines(cleanup: ChatCleanup): string[] {
  const lines: string[] = [];
  if (cleanup.branch) {
    lines.push(`The clean-up is on the local branch ${cleanup.branch}.`);
  }
  if (cleanup.historyHoldsPayload) {
    lines.push("That clean-up left the malicious code in git history. Amending history is what rewrites those commits. The checkout fix does not.");
  }
  if (cleanup.partial || cleanup.needsYou) {
    lines.push("Part of the clean-up still needs you. The fix report says what.");
  }
  return lines;
}

function machineCard(machine: ChatMachineInput): ChatCard {
  const paragraphs: string[] = [];
  const actions: ChatButton[] = [];
  if (machine.auditing) {
    paragraphs.push(machine.auditProgress ? `Auditing: ${machine.auditProgress}` : "Auditing this machine.");
  } else if (machine.auditLabel) {
    paragraphs.push(`Changing credentials: ${machine.auditLabel}. An audit does not change them.`);
  } else {
    paragraphs.push("This machine has not been audited yet. Audit it before you change a password or token. An audit does not change them.");
  }
  actions.push({ act: "audit", label: machine.auditLabel ? "Audit again" : "Audit this machine", tone: "secondary" });
  switch (machine.hooks) {
    case "checking":
      paragraphs.push("Checking scan-on-clone hooks.");
      break;
    case "installed":
      paragraphs.push(machine.hooksDetail ? `Scan-on-clone hooks are in place (${machine.hooksDetail}).` : "Scan-on-clone hooks are in place.");
      break;
    case "repair":
      paragraphs.push("Scan-on-clone hooks need repair.");
      actions.push({ act: "hooks:repair", label: "Repair hooks", tone: "primary" });
      break;
    case "missing":
      paragraphs.push("Scan-on-clone hooks are not installed. A clone, pull, or branch switch is scanned when they are.");
      actions.push({ act: "hooks:install", label: "Install hooks", tone: "primary" });
      break;
    case "unknown":
      paragraphs.push(machine.hooksDetail || "saw could not say whether the hooks are installed.");
      actions.push({ act: "hooks:check", label: "Check hooks", tone: "secondary" });
      break;
  }
  actions.push({ act: "docs", label: "What each verdict means", tone: "secondary" });
  return {
    badge: machine.auditing ? "auditing" : "this machine",
    title: "This machine",
    tone: "neutral",
    paragraphs,
    rows: [],
    actions,
  };
}

/** Buttons that match the editor's own button colors, in a webview. */
export function buttonCss(): string {
  return `
    button { font: inherit; cursor: pointer; border-radius: 6px; padding: 6px 12px; border: 1px solid transparent; }
    button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.danger { background: transparent; color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
    button:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  `;
}

/** The chat page. Every string from a scan is escaped, so it cannot become markup. */
export function renderChat(cards: ChatCard[], nonce: string): string {
  const body = cards.map((card) => cardHtml(card)).join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${escapeHtml(nonce)}'; script-src 'nonce-${escapeHtml(nonce)}'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style nonce="${escapeHtml(nonce)}">
  body { margin: 0; padding: 12px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-size: var(--vscode-font-size); }
  .thread { display: flex; flex-direction: column; gap: 12px; }
  .who { font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--vscode-descriptionForeground); margin: 0 0 4px; }
  .card { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 8px; padding: 10px 12px; background: var(--vscode-editor-background); }
  .card.bad { border-color: var(--vscode-inputValidation-errorBorder); }
  .card.warn { border-color: var(--vscode-inputValidation-warningBorder); }
  .card.ok { border-color: var(--vscode-testing-iconPassed, var(--vscode-inputValidation-infoBorder)); }
  .head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .title { font-weight: 600; }
  p { margin: 0 0 8px; line-height: 1.45; }
  .rows { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
  .rows button { text-align: left; width: 100%; background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .actions button.primary, .actions button.danger { flex: 1 1 100%; }
  ${buttonCss()}
</style>
</head>
<body>
<div class="thread">${body}</div>
<script nonce="${escapeHtml(nonce)}">
  const vscode = acquireVsCodeApi();
  document.body.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("button[data-act]") : null;
    if (!button) return;
    vscode.postMessage({ act: button.getAttribute("data-act") });
  });
</script>
</body>
</html>`;
}

function cardHtml(card: ChatCard): string {
  const paragraphs = card.paragraphs.map((line) => `<p>${escapeHtml(plain(line, 500))}</p>`).join("");
  const rows = card.rows.length
    ? `<div class="rows">${card.rows.map((button) => buttonHtml(button)).join("")}</div>`
    : "";
  const actions = card.actions.length
    ? `<div class="actions">${card.actions.map((button) => buttonHtml(button)).join("")}</div>`
    : "";
  return `<article>
    <p class="who">saw</p>
    <section class="card ${card.tone}">
      <div class="head"><span class="badge">${escapeHtml(plain(card.badge, 80))}</span><span class="title">${escapeHtml(plain(card.title, 120))}</span></div>
      ${paragraphs}${rows}${actions}
    </section>
  </article>`;
}

function buttonHtml(button: ChatButton): string {
  return `<button type="button" class="${button.tone}" data-act="${escapeHtml(button.act)}">${escapeHtml(plain(button.label, 200))}</button>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}
