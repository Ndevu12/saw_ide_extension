import * as vscode from "vscode";

import { Alerts } from "./editor/alerts";
import { Controller } from "./editor/controller";
import { Diagnostics } from "./editor/diagnostics";
import { EngineResolver } from "./editor/engine";
import { Installer, readPins } from "./editor/installer";
import { Model } from "./editor/model";
import { readSettings } from "./editor/settings";
import { StatusBar } from "./editor/statusBar";
import { FindingsTree } from "./editor/tree";
import { registerTriggers } from "./editor/triggers";

export interface SawApi {
  readonly model: Model;
  readonly controller: Controller;
}

export function activate(context: vscode.ExtensionContext): SawApi {
  const log = vscode.window.createOutputChannel("saw", { log: true });
  const model = new Model();
  const installer = new Installer(context, log, readPins(context));
  const engines = new EngineResolver(log, readSettings, installer, () => model.setEngine({ kind: "installing" }));
  const diagnostics = new Diagnostics(log);
  const alerts = new Alerts();
  const controller = new Controller(model, engines, diagnostics, alerts, readSettings, log);
  const tree = new FindingsTree(model);
  installer.exposeToTerminals();

  context.subscriptions.push(
    log,
    model,
    diagnostics,
    controller,
    tree,
    new StatusBar(model),
    vscode.window.registerTreeDataProvider("saw.findings", tree),
    vscode.commands.registerCommand("saw.scanWorkspace", () => {
      engines.reset();
      alerts.resetEngineWarning();
      controller.requestAll({ immediate: true });
    }),
    vscode.commands.registerCommand("saw.install", async () => {
      alerts.resetEngineWarning();
      const engine = await engines.reinstall();
      model.setEngine(engine);
      if (engine.kind === "ready") {
        controller.requestAll({ immediate: true });
      }
    }),
    vscode.commands.registerCommand("saw.copyDiagnostics", async () => {
      const report = installer.diagnostics();
      if (!report) {
        void vscode.window.showInformationMessage("No install has run in this window yet, so there is nothing to copy. See the log instead.");
        return;
      }
      await vscode.env.clipboard.writeText(report);
      void vscode.window.showInformationMessage("The install diagnostics are on the clipboard, ready to paste into an issue.");
    }),
    vscode.commands.registerCommand("saw.showOutput", () => log.show()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("saw")) {
        engines.reset();
        alerts.resetEngineWarning();
        controller.requestAll({ immediate: true });
      }
    }),
    ...registerTriggers(controller, readSettings),
  );

  if (readSettings().scanOnStartup && vscode.workspace.workspaceFolders?.length) {
    controller.requestAll({ immediate: true });
  } else {
    void engines.resolve().then((engine) => model.setEngine(engine));
  }
  return { model, controller };
}

export function deactivate(): void {}
