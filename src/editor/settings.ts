import * as vscode from "vscode";

export interface Settings {
  path: string;
  configPath: string;
  scanOnStartup: boolean;
  scanOnChange: boolean;
  timeoutMs: number;
  autoInstall: boolean;
  registerMcpServer: boolean;
}

// Every saw setting is machine-scoped in package.json, so a workspace's own settings file can
// neither choose the program that runs nor turn the scan off.
export function readSettings(): Settings {
  const config = vscode.workspace.getConfiguration("saw");
  return {
    path: config.get<string>("path", ""),
    configPath: config.get<string>("configPath", ""),
    scanOnStartup: config.get<boolean>("scanOnStartup", true),
    scanOnChange: config.get<boolean>("scanOnChange", true),
    timeoutMs: Math.max(5, config.get<number>("scanTimeoutSeconds", 120)) * 1000,
    autoInstall: config.get<boolean>("autoInstall", true),
    registerMcpServer: config.get<boolean>("registerMcpServer", true),
  };
}
