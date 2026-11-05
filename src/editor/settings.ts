import * as vscode from "vscode";

import { configOutsideFolders, isBoolean, isNumber, isString, owned, timeoutMs } from "../core/controls";

export interface Settings {
  path: string;
  configPath: string;
  scanOnStartup: boolean;
  scanOnChange: boolean;
  timeoutMs: number;
  autoInstall: boolean;
  registerMcpServer: boolean;
  guardAgentCommands: boolean;
  governUpdates: boolean;
}

// The machine value only. A workspace or folder value is never read, even when the editor would
// merge one in. A config path inside an open folder is dropped.
export function readSettings(): Settings {
  const saw = vscode.workspace.getConfiguration("saw");
  const folders = (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === "file").map((folder) => folder.uri.fsPath);
  const configured = owned(saw.inspect<string>("configPath"), "", isString);
  return {
    path: owned(saw.inspect<string>("path"), "", isString),
    configPath: configOutsideFolders(configured, folders),
    scanOnStartup: owned(saw.inspect<boolean>("scanOnStartup"), true, isBoolean),
    scanOnChange: owned(saw.inspect<boolean>("scanOnChange"), true, isBoolean),
    timeoutMs: timeoutMs(owned(saw.inspect<number>("scanTimeoutSeconds"), 120, isNumber)),
    autoInstall: owned(saw.inspect<boolean>("autoInstall"), true, isBoolean),
    registerMcpServer: owned(saw.inspect<boolean>("registerMcpServer"), true, isBoolean),
    guardAgentCommands: owned(saw.inspect<boolean>("guardAgentCommands"), true, isBoolean),
    governUpdates: owned(saw.inspect<boolean>("governUpdates"), true, isBoolean),
  };
}
