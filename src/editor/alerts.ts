import * as vscode from "vscode";

import { plain } from "../core/text";
import type { FolderVerdict } from "../core/verdict";
import type { Engine } from "./engine";
import type { Settled } from "./model";
function confirmedCount(outcome: Settled): number {
  if (outcome.kind !== "scanned") {
    return 0;
  }
  return outcome.payload.results.reduce(
    (sum, result) => sum + result.findings.filter((f) => f.confidence === "confirmed").length,
    0,
  );
}

/** Speaks up when a folder's verdict changes to one that needs the user, once per change. */
export class Alerts {
  private engineWarned = false;

  async verdictChanged(folder: vscode.WorkspaceFolder, before: FolderVerdict | undefined, outcome: Settled): Promise<void> {
    if (outcome.verdict === before) {
      return;
    }
    if (outcome.verdict === "infected") {
      await this.infected(folder, outcome);
    } else if (outcome.verdict === "incomplete") {
      const reason = plain(outcome.reasons[0] ?? "saw did not finish", 300);
      void vscode.window.showWarningMessage(`saw could not scan ${folder.name} fully, so it is not shown as clean: ${reason}`, "Show Log")
        .then((choice) => choice && vscode.commands.executeCommand("saw.showOutput"));
    }
  }

  private async infected(folder: vscode.WorkspaceFolder, outcome: Settled): Promise<void> {
    const count = confirmedCount(outcome);
    const what = `saw: ${folder.name} is INFECTED — ${count} confirmed finding${count === 1 ? "" : "s"}.`;
    const act = "saw can remove what it confirms; nothing from the folder runs while it does.";
    const choice = vscode.workspace.isTrusted
      ? await vscode.window.showErrorMessage(`${what} ${act}`, "Fix…", "Show Findings")
      : await vscode.window.showWarningMessage(
          `${what} Do not trust this folder: Restricted Mode keeps its tasks and debug configurations from running. ${act}`,
          { modal: true },
          "Fix…",
          "Show Findings",
        );
    if (choice === "Fix…") {
      await vscode.commands.executeCommand("saw.fixFolder", folder);
    } else if (choice === "Show Findings") {
      await vscode.commands.executeCommand("workbench.view.extension.saw");
    }
  }

  async engineUnavailable(engine: Extract<Engine, { kind: "unavailable" }>): Promise<void> {
    // The installer has already said why it failed and what to do; a cancel was the operator's own.
    if (this.engineWarned || engine.reason === "install-failed" || engine.reason === "install-cancelled") {
      return;
    }
    this.engineWarned = true;
    const actions =
      engine.reason === "invalid-setting" ? ["Open Setting", "Show Log"] : engine.reason === "unsupported-platform" ? [] : ["Install saw", "Show Log"];
    const choice = await vscode.window.showWarningMessage(`${engine.message} No folder was scanned.`, ...actions);
    if (choice === "Install saw") {
      await vscode.commands.executeCommand("saw.install");
    } else if (choice === "Open Setting") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "saw.path");
    } else if (choice === "Show Log") {
      await vscode.commands.executeCommand("saw.showOutput");
    }
  }

  resetEngineWarning(): void {
    this.engineWarned = false;
  }
}
