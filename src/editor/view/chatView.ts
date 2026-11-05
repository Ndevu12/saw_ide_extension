import * as vscode from "vscode";

import { DOCS } from "../../core/docs";
import { chatCards, renderChat, SHOWN_FINDINGS, type ChatCleanup, type ChatFolderInput, type ChatMachineInput } from "../../core/chat/transcript";
import type { Finding } from "../../core/scan/contract";
import { plain } from "../../core/text";
import type { AuditVerdict, FixOutcome, HookStatus } from "../../core/fix/actions";
import type { Feedback } from "../feedback/feedback";
import type { Decide } from "../fix/decide";
import type { Controller } from "../scan/controller";
import { findingRange, findingUri } from "../scan/diagnostics";
import type { FolderState, Model } from "../model";

const AUDIT_LABEL: Record<AuditVerdict, string> = {
  "no-hazard": "no hazard found",
  "to-confirm": "safe once you confirm saw's items",
  "rotation-unsafe": "do not change them yet",
  incomplete: "not known to be safe",
  failed: "audit did not finish",
};

interface OpenTarget {
  target: string;
  finding: Finding;
}

/**
 * The chat sidebar. It is a webview, so the same layout runs in every IDE built on VS Code.
 * Buttons call the commands the rest of the extension already has. Closing it answers nothing.
 */
export class ChatView implements vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private verdict: vscode.WebviewPanel | undefined;
  private folders: vscode.WorkspaceFolder[] = [];
  private opens: OpenTarget[][] = [];
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly model: Model,
    private readonly controller: Controller,
    private readonly checkHooks: () => void,
    private readonly lastFix: (folder: vscode.WorkspaceFolder) => FixOutcome | undefined,
    private readonly openFixReport: (folder: vscode.WorkspaceFolder) => void,
    private readonly decide: Decide,
    private readonly feedback: Feedback,
  ) {
    this.subscriptions = [
      model.onDidChange(() => this.render()),
      feedback.onDidChange(() => this.render()),
      vscode.window.registerWebviewViewProvider("saw.chat", {
        resolveWebviewView: (view) => {
          this.view = view;
          view.webview.options = { enableScripts: true };
          view.webview.onDidReceiveMessage((message: { act?: unknown }) => this.onMessage(message));
          view.onDidDispose(() => {
            this.view = undefined;
          });
          this.render();
        },
      }),
      vscode.commands.registerCommand("saw.openVerdict", () => this.openVerdict()),
    ];
  }

  /** The same session as Chat, in an editor tab. Chat keeps the buttons. */
  openVerdict(): void {
    if (this.verdict) {
      this.verdict.reveal(vscode.ViewColumn.Active);
      this.render();
      return;
    }
    const panel = vscode.window.createWebviewPanel("saw.verdict", "saw", vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.verdict = panel;
    const messages = panel.webview.onDidReceiveMessage((message: { act?: unknown }) => this.onMessage(message));
    const gone = panel.onDidDispose(() => {
      messages.dispose();
      gone.dispose();
      if (this.verdict === panel) {
        this.verdict = undefined;
      }
    });
    this.render();
  }

  private render(): void {
    const states = this.model.states();
    this.folders = states.map((state) => state.folder);
    this.opens = states.map((state) => openings(state));
    const cards = chatCards(states.map((state) => folderInput(state, this.decide, this.lastFix)), this.machineInput(), this.feedback.card());
    if (this.view) {
      this.view.webview.html = renderChat(cards, nonce(), "side");
    }
    if (this.verdict) {
      this.verdict.webview.html = renderChat(cards, nonce(), "editor");
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
      ...(audit ? { auditLabel: AUDIT_LABEL[audit.verdict] } : {}),
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
      case "fix-report":
        if (folder) {
          this.openFixReport(folder);
        }
        return;
      case "decide":
        void vscode.commands.executeCommand("saw.decideShow");
        return;
      case "verdict":
        this.openVerdict();
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
    this.verdict?.dispose();
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }
}

function nonce(): string {
  return Math.random().toString(36).slice(2);
}

function folderInput(state: FolderState, decide: Decide, lastFix: (folder: vscode.WorkspaceFolder) => FixOutcome | undefined): ChatFolderInput {
  const last = state.last;
  const findings = last?.kind === "scanned"
    ? last.payload.results.flatMap((result) => [...result.findings, ...result.informational].map((finding) => ({
        label: plain(finding.line ? `${finding.path}:${finding.line} — ${finding.description}` : `${finding.path} — ${finding.description}`, 180),
      })))
    : [];
  const held = state.held && !state.held.released ? { verdict: state.held.verdict, reasons: state.held.reasons } : undefined;
  return {
    name: state.folder.name,
    phase: state.deciding ? "deciding" : state.fixing ? "fixing" : state.scanning ? "scanning" : "idle",
    ...(state.progress ? { progress: state.progress } : {}),
    ...(last ? { verdict: last.verdict } : {}),
    reasons: last?.reasons ?? [],
    findings,
    ...(held ? { held } : {}),
    ...(state.checking ? { checking: true, ...(state.checkStep ? { checkStep: state.checkStep } : {}), ...(state.checkAbout ? { checkAbout: state.checkAbout } : {}) } : {}),
    ...(state.unheld ? { unheld: true, ...(state.unheldFrom ? { unheldFrom: state.unheldFrom } : {}) } : {}),
    ...decisionOf(state, decide),
    ...cleanupOf(lastFix(state.folder)),
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
  return found.slice(0, SHOWN_FINDINGS);
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
