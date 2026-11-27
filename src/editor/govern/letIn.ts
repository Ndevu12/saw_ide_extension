import * as vscode from "vscode";

import { letInArgs } from "../../core/govern/contract";

/** How the operator answers saw about an update it held for a folder. */
export interface LetInChannel {
  letIn(saw: string, folder: vscode.WorkspaceFolder): void;
}

export class TerminalLetIn implements LetInChannel {
  letIn(saw: string, folder: vscode.WorkspaceFolder): void {
    vscode.window.createTerminal({
      name: `saw: ${folder.name}`,
      cwd: folder.uri,
      shellPath: saw,
      shellArgs: letInArgs(folder.uri.fsPath),
    }).show();
  }
}
