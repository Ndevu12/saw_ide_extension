import * as vscode from "vscode";

import { DOCS } from "./core/docs";
import { Actions } from "./editor/fix/actions";
import { FOLDER_VERDICT_TOOL, FolderVerdictTool } from "./editor/agent/agentTool";
import { Alerts } from "./editor/view/alerts";
import { Controller } from "./editor/scan/controller";
import { CursorAgentGuard } from "./editor/agent/cursorGuard";
import { Decide } from "./editor/fix/decide";
import { Diagnostics } from "./editor/scan/diagnostics";
import { EngineResolver } from "./editor/install/engine";
import { Installer, readPins } from "./editor/install/installer";
import { SawMcpRegistration } from "./editor/agent/mcp";
import { Model } from "./editor/model";
import { Reports } from "./editor/view/reports";
import { readSettings } from "./editor/settings";
import { StatusBar } from "./editor/view/statusBar";
import { FindingsTree } from "./editor/view/tree";
import { registerTriggers } from "./editor/scan/triggers";

export interface SawApi {
  readonly model: Model;
  readonly controller: Controller;
  readonly reports: Reports;
  readonly cursorGuard: CursorAgentGuard;
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
  const reports = new Reports(model, context.storageUri?.fsPath, context.globalStorageUri.fsPath, log);
  const cursorGuard = new CursorAgentGuard(model, readSettings, context.globalStorageUri.fsPath, context.asAbsolutePath("dist/cursor-hook.js"), log);
  const decide = new Decide(model, log);
  const actions = new Actions(model, engines, controller, readSettings, log, context.globalState, reports, decide);
  installer.exposeToTerminals();
  const folderOf = (arg: unknown): vscode.WorkspaceFolder | undefined => {
    const node = arg as { state?: { folder?: vscode.WorkspaceFolder }; uri?: vscode.Uri } | undefined;
    return node?.state?.folder ?? (node?.uri ? vscode.workspace.getWorkspaceFolder(node.uri) : undefined);
  };

  context.subscriptions.push(
    log,
    model,
    diagnostics,
    controller,
    reports,
    decide,
    cursorGuard,
    tree,
    new StatusBar(model),
    new SawMcpRegistration(model, readSettings, log),
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
        void actions.refreshHooks();
      }
    }),
    vscode.commands.registerCommand("saw.openReport", async (arg?: unknown) => {
      const kind = (arg as { kind?: unknown } | undefined)?.kind;
      const folder = folderOf(arg);
      const uri = kind === "audit" || kind === "hooks" ? reports.machineUri(kind) : folder ? reports.scanUri(folder) : await reports.choose();
      if (uri) {
        await reports.open(uri);
      }
    }),
    vscode.commands.registerCommand("saw.fixFolder", (arg?: unknown) => actions.fixFolder(folderOf(arg))),
    vscode.commands.registerCommand("saw.auditMachine", () => actions.auditMachine()),
    vscode.commands.registerCommand("saw.installHooks", () => actions.hooks("install")),
    vscode.commands.registerCommand("saw.repairHooks", () => actions.hooks("repair")),
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
    vscode.commands.registerCommand("saw.openDocumentation", () => vscode.env.openExternal(vscode.Uri.parse(DOCS.home))),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("saw")) {
        engines.reset();
        alerts.resetEngineWarning();
        controller.requestAll({ immediate: true });
      }
    }),
    ...registerTriggers(controller, readSettings),
  );
  // Forks of VS Code may leave out the language-model API; scanning does not depend on it.
  if (typeof vscode.lm?.registerTool === "function") {
    context.subscriptions.push(vscode.lm.registerTool(FOLDER_VERDICT_TOOL, new FolderVerdictTool(model, controller, readSettings)));
  }

  if (readSettings().scanOnStartup && vscode.workspace.workspaceFolders?.length) {
    controller.requestAll({ immediate: true });
  } else {
    void engines.resolve().then((engine) => model.setEngine(engine));
  }
  void actions.refreshHooks();
  return { model, controller, reports, cursorGuard };
}

export function deactivate(): void {}
