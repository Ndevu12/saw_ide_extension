import * as vscode from "vscode";

import { DOCS } from "../../core/docs";
import { chatPage, renderChat, VERDICT_BADGE, type ChatCleanup, type ChatFolderInput, type ChatMachineInput, type Tone } from "../../core/chat/transcript";
import { renderVerdict, verdictPage } from "../../core/chat/verdictPage";
import type { Finding } from "../../core/scan/contract";
import { plain } from "../../core/text";
import type { AmendOutcome, AuditVerdict, FixOutcome, HookStatus } from "../../core/fix/actions";
import type { Feedback } from "../feedback/feedback";
import type { Decide } from "../fix/decide";
import type { Controller } from "../scan/controller";
import { findingRange, findingUri } from "../scan/diagnostics";
import type { FolderState, Model } from "../model";

const AUDIT_LABEL: Record<AuditVerdict, string> = {
  "no-hazard": "safe to change them",
  "to-confirm": "safe once you confirm a few items",
  "rotation-unsafe": "do not change them yet",
  incomplete: "not known to be safe",
  failed: "the check did not finish",
};

const AUDIT_TONE: Record<AuditVerdict, Tone> = {
  "no-hazard": "ok",
  "to-confirm": "warn",
  "rotation-unsafe": "bad",
  incomplete: "warn",
  failed: "warn",
};

/** What the two fixes, `saw fix` on the files and `saw fix amend` on git history, last did here. */
export interface FixRuns {
  files(folder: vscode.WorkspaceFolder): FixOutcome | undefined;
  history(folder: vscode.WorkspaceFolder): AmendOutcome | "running" | undefined;
  open(folder: vscode.WorkspaceFolder, treatment: "files" | "history"): void;
}

interface OpenTarget {
  target: string;
  finding: Finding;
}

/** A webview and the last page it was given, so a redraw that changes nothing is skipped. */
interface Surface {
  webview: vscode.Webview;
  nonce: string;
  html?: string;
}

/**
 * The chat sidebar, and a verdict tab per folder. Both are webviews, so the same layout runs in
 * every IDE built on VS Code. Buttons call the commands the rest of the extension already has.
 */
export class ChatView implements vscode.Disposable {
  private view: Surface | undefined;
  private readonly verdicts = new Map<string, { panel: vscode.WebviewPanel; surface: Surface }>();
  private folders: vscode.WorkspaceFolder[] = [];
  private opens: OpenTarget[][] = [];
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly model: Model,
    private readonly controller: Controller,
    private readonly checkHooks: () => void,
    private readonly fixes: FixRuns,
    private readonly decide: Decide,
    private readonly feedback: Feedback,
    private readonly icon: { light: vscode.Uri; dark: vscode.Uri },
  ) {
    this.subscriptions = [
      model.onDidChange(() => this.render()),
      feedback.onDidChange(() => this.render()),
      vscode.window.registerWebviewViewProvider("saw.chat", {
        resolveWebviewView: (view) => {
          this.view = { webview: view.webview, nonce: nonce() };
          view.webview.options = { enableScripts: true };
          view.webview.onDidReceiveMessage((message: { act?: unknown }) => this.onMessage(message));
          view.onDidDispose(() => {
            this.view = undefined;
          });
          this.render();
        },
      }),
      vscode.commands.registerCommand("saw.openVerdict", (arg?: unknown) => this.openVerdict(arg)),
    ];
  }

  /** A folder's verdict in an editor tab. One tab per folder; asking again brings it forward. */
  async openVerdict(arg?: unknown): Promise<void> {
    const states = this.model.states();
    let folder = folderArg(arg) ?? (typeof arg === "number" ? states[arg]?.folder : undefined);
    if (!folder && states.length === 1) {
      folder = states[0]?.folder;
    }
    if (!folder && states.length > 1) {
      const picked = await vscode.window.showQuickPick(
        states.map((state) => ({ label: state.folder.name, description: state.last ? VERDICT_BADGE[state.last.verdict] : "not scanned", folder: state.folder })),
        { placeHolder: "Folder whose scan results to open" },
      );
      folder = picked?.folder;
    }
    if (!folder) {
      return;
    }
    const key = folder.uri.toString();
    const open = this.verdicts.get(key);
    if (open) {
      open.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel("saw.verdict", `Scan results · ${folder.name}`, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    panel.iconPath = this.icon;
    this.verdicts.set(key, { panel, surface: { webview: panel.webview, nonce: nonce() } });
    const messages = panel.webview.onDidReceiveMessage((message: { act?: unknown }) => this.onMessage(message));
    const gone = panel.onDidDispose(() => {
      messages.dispose();
      gone.dispose();
      if (this.verdicts.get(key)?.panel === panel) {
        this.verdicts.delete(key);
      }
    });
    this.render();
  }

  private render(): void {
    const states = this.model.states();
    this.folders = states.map((state) => state.folder);
    this.opens = states.map((state) => openings(state));
    const inputs = states.map((state) => folderInput(state, this.decide, this.fixes));
    if (this.view) {
      draw(this.view, renderChat(chatPage(inputs, this.machineInput(), this.feedback.card()), this.view.nonce));
    }
    for (const [key, { panel, surface }] of this.verdicts) {
      const index = this.folders.findIndex((folder) => folder.uri.toString() === key);
      const input = inputs[index];
      if (!input) {
        panel.dispose();
        continue;
      }
      draw(surface, renderVerdict(verdictPage(input, index), surface.nonce));
    }
  }

  private machineInput(): ChatMachineInput {
    const engine = this.model.engine;
    const hooks = this.model.machine.hooks;
    const audit = this.model.machine.audit;
    const detail = hooksDetail(hooks);
    return {
      engine: engineInput(engine),
      auditing: this.model.machine.auditing,
      ...(this.model.machine.auditProgress ? { auditProgress: this.model.machine.auditProgress } : {}),
      ...(audit ? { auditLabel: AUDIT_LABEL[audit.verdict], auditTone: AUDIT_TONE[audit.verdict] } : {}),
      hooks: hooksKind(hooks),
      ...(detail ? { hooksDetail: detail } : {}),
      readingWatch: this.model.machine.readingWatch,
      ...(this.model.machine.watch ? { watchLine: this.model.machine.watch.line } : {}),
    };
  }

  private onMessage(message: { act?: unknown }): void {
    if (!message || typeof message.act !== "string") {
      return;
    }
    const [act, first, second] = message.act.split(":");
    const index = Number(first);
    const folder = this.folders[index];
    switch (act) {
      case "scan":
        if (folder) {
          this.controller.request(folder, { immediate: true });
        }
        return;
      case "fix":
        if (folder) {
          void vscode.commands.executeCommand("saw.fixFolder", { state: { folder } });
        }
        return;
      case "report":
        if (folder) {
          void vscode.commands.executeCommand("saw.openReport", { state: { folder } });
        }
        return;
      case "amend":
        if (folder) {
          void vscode.commands.executeCommand("saw.amendHistory", { state: { folder } });
        }
        return;
      case "fix-report":
        if (folder) {
          this.fixes.open(folder, "files");
        }
        return;
      case "amend-report":
        if (folder) {
          this.fixes.open(folder, "history");
        }
        return;
      case "decide":
        void vscode.commands.executeCommand("saw.decideShow");
        return;
      case "verdict":
        void this.openVerdict(index);
        return;
      case "open": {
        const opening = this.opens[index]?.[Number(second)];
        if (!opening) {
          return;
        }
        const uri = findingUri(opening.target, opening.finding);
        if (uri) {
          void vscode.window.showTextDocument(uri, { selection: findingRange(opening.finding), preview: true });
        }
        return;
      }
      case "audit":
        void vscode.commands.executeCommand("saw.auditMachine");
        return;
      case "watch":
        void vscode.commands.executeCommand("saw.openWatchReport");
        return;
      case "machine":
        void vscode.commands.executeCommand("saw.openReport", { kind: first });
        return;
      case "reports":
        void vscode.commands.executeCommand("saw.openReport");
        return;
      case "log":
        void vscode.commands.executeCommand("saw.showOutput");
        return;
      case "hooks":
        if (first === "install") {
          void vscode.commands.executeCommand("saw.installHooks");
        } else if (first === "repair") {
          void vscode.commands.executeCommand("saw.repairHooks");
        } else {
          this.checkHooks();
        }
        return;
      case "install":
        void vscode.commands.executeCommand("saw.install");
        return;
      case "docs":
        void vscode.env.openExternal(vscode.Uri.parse(DOCS.verdicts));
        return;
      case "feedback":
        this.feedback.act(first);
        return;
      default:
        return;
    }
  }

  dispose(): void {
    for (const { panel } of this.verdicts.values()) {
      panel.dispose();
    }
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }
}

function nonce(): string {
  return Math.random().toString(36).slice(2);
}

function draw(surface: Surface, html: string): void {
  if (surface.html !== html) {
    surface.html = html;
    surface.webview.html = html;
  }
}

function folderArg(arg: unknown): vscode.WorkspaceFolder | undefined {
  const node = arg as { state?: { folder?: vscode.WorkspaceFolder }; uri?: vscode.Uri } | undefined;
  return node?.state?.folder ?? (node?.uri ? vscode.workspace.getWorkspaceFolder(node.uri) : undefined);
}

function folderInput(state: FolderState, decide: Decide, fixes: FixRuns): ChatFolderInput {
  const last = state.last;
  const findings = openings(state).map(({ finding }, open) => ({
    what: plain(finding.description, 300),
    where: plain(finding.line ? `${finding.path}:${finding.line}` : finding.path, 200),
    severity: finding.severity,
    open,
  }));
  const held = state.held && !state.held.released ? { verdict: state.held.verdict, reasons: state.held.reasons } : undefined;
  const advisories = last?.kind === "scanned" ? last.payload.results.reduce((sum, result) => sum + result.advisories.length, 0) : 0;
  return {
    name: state.folder.name,
    path: state.folder.uri.fsPath,
    advisories,
    phase: state.deciding ? "deciding" : state.fixing ? "fixing" : state.scanning ? "scanning" : "idle",
    ...(state.fixing && state.treating ? { treating: state.treating } : {}),
    ...(state.progress ? { progress: state.progress } : {}),
    ...(last ? { verdict: last.verdict } : {}),
    reasons: last?.reasons ?? [],
    findings,
    ...(held ? { held } : {}),
    ...(state.checking ? { checking: true, ...(state.checkStep ? { checkStep: state.checkStep } : {}), ...(state.checkAbout ? { checkAbout: state.checkAbout } : {}) } : {}),
    ...(state.unheld ? { unheld: true, ...(state.unheldFrom ? { unheldFrom: state.unheldFrom } : {}) } : {}),
    ...decisionOf(state, decide),
    ...cleanupOf(fixes.files(state.folder)),
    ...historyOf(fixes.history(state.folder)),
  };
}

function decisionOf(state: FolderState, decide: Decide): { decision: string } | Record<string, never> {
  const waiting = decide.waitingOn();
  if (!waiting || waiting.folder.uri.toString() !== state.folder.uri.toString()) {
    return {};
  }
  return { decision: waiting.specialty };
}

function cleanupOf(outcome: FixOutcome | undefined): { cleanup: ChatCleanup } | Record<string, never> {
  if (!outcome || outcome.kind !== "prepared") {
    return {};
  }
  const details = outcome.details;
  return {
    cleanup: {
      ...(details?.branch ? { branch: details.branch } : {}),
      historyHoldsPayload: details?.historyHoldsPayload === true,
      partial: details?.partial === true,
      needsYou: outcome.needsReview,
    },
  };
}

function historyOf(outcome: AmendOutcome | "running" | undefined): { history: NonNullable<ChatFolderInput["history"]> } | Record<string, never> {
  if (!outcome) {
    return {};
  }
  return { history: outcome === "running" ? "running" : outcome.kind };
}

function openings(state: FolderState): OpenTarget[] {
  if (state.last?.kind !== "scanned") {
    return [];
  }
  const found: OpenTarget[] = [];
  for (const result of state.last.payload.results) {
    for (const finding of [...result.findings, ...result.informational]) {
      found.push({ target: result.target, finding });
    }
  }
  return found;
}

function engineInput(engine: Model["engine"]): ChatMachineInput["engine"] {
  if (!engine || engine.kind === "ready") {
    return { phase: "ready", canInstall: false };
  }
  if (engine.kind === "installing") {
    return { phase: "installing", canInstall: false };
  }
  const canInstall = engine.reason === "missing" || engine.reason === "too-old" || engine.reason === "install-failed";
  return { phase: "unavailable", message: engine.message, canInstall };
}

function hooksKind(hooks: HookStatus | undefined): ChatMachineInput["hooks"] {
  if (!hooks) {
    return "checking";
  }
  if (hooks.kind === "not-installed") {
    return "missing";
  }
  if (hooks.kind === "unknown") {
    return "unknown";
  }
  return hooks.problems.length ? "repair" : "installed";
}

function hooksDetail(hooks: HookStatus | undefined): string | undefined {
  if (!hooks) {
    return undefined;
  }
  if (hooks.kind === "installed" && !hooks.problems.length) {
    return hooks.events.join(", ");
  }
  if (hooks.kind === "unknown") {
    return hooks.detail;
  }
  return undefined;
}
