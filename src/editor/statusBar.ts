import * as vscode from "vscode";

import type { FolderVerdict } from "../core/verdict";
import type { FolderState, Model } from "./model";
import { VERDICT_LABEL } from "./present";

const ICON: Record<FolderVerdict, string> = {
  clean: "$(shield)",
  residue: "$(info)",
  suspicious: "$(warning)",
  incomplete: "$(circle-slash)",
  infected: "$(error)",
};

const BACKGROUND: Partial<Record<FolderVerdict, vscode.ThemeColor>> = {
  suspicious: new vscode.ThemeColor("statusBarItem.warningBackground"),
  incomplete: new vscode.ThemeColor("statusBarItem.warningBackground"),
  infected: new vscode.ThemeColor("statusBarItem.errorBackground"),
};

function scanningTooltip(states: FolderState[]): string {
  const steps = states.filter((state) => state.scanning && state.progress).map((state) => `${state.folder.name}: ${state.progress}`);
  return ["saw is scanning this workspace.", ...steps].join("\n");
}

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem("saw.verdict", vscode.StatusBarAlignment.Left, 100);
  private readonly subscription: vscode.Disposable;

  constructor(private readonly model: Model) {
    this.item.name = "SAW BOT verdict";
    this.subscription = model.onDidChange(() => this.render());
    this.render();
    this.item.show();
  }

  private render(): void {
    const engine = this.model.engine;
    const states = this.model.states();
    if (engine?.kind === "installing") {
      this.item.text = "$(sync~spin) SAW BOT: installing saw";
      this.item.tooltip = "saw is being installed with pipx. Folders are scanned as soon as it is ready.";
      this.item.backgroundColor = undefined;
      this.item.command = "saw.showOutput";
      return;
    }
    if (engine?.kind === "unavailable") {
      this.item.text = "$(circle-slash) SAW BOT: saw not available";
      const canInstall = engine.reason !== "invalid-setting" && engine.reason !== "unsupported-platform";
      this.item.tooltip = `${engine.message}\nSince no scan ran, no folder is shown as clean.${canInstall ? " Click to install or repair saw." : ""}`;
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      this.item.command = canInstall ? "saw.install" : "saw.showOutput";
      return;
    }
    this.item.command = "workbench.view.extension.saw";
    const scanning = states.some((state) => state.scanning);
    const progress = states.find((state) => state.scanning && state.progress)?.progress;
    const overall = this.model.overall();
    if (!overall) {
      this.item.text = scanning ? `$(sync~spin) SAW BOT: scanning${progress ? `: ${progress}` : ""}` : "$(shield) SAW BOT";
      this.item.tooltip = scanning ? scanningTooltip(states) : "No scan has run yet.";
      this.item.backgroundColor = undefined;
      return;
    }
    this.item.text = `${scanning ? "$(sync~spin)" : ICON[overall]} SAW BOT: ${VERDICT_LABEL[overall]}`;
    this.item.backgroundColor = BACKGROUND[overall];
    this.item.tooltip = states
      .flatMap((state) => {
        if (state.scanning && state.progress) {
          return [`${state.folder.name}: scanning: ${state.progress}`];
        }
        return state.last ? [`${state.folder.name}: ${VERDICT_LABEL[state.last.verdict]}`] : [];
      })
      .join("\n");
  }

  dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }
}
