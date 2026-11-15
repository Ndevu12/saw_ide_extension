import * as vscode from "vscode";

import { plain } from "../../core/text";
import type { FolderVerdict } from "../../core/scan/verdict";
import { VERDICT_LABEL } from "../present";
import type { Engine } from "../install/engine";
import type { Settled } from "../model";
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
      void vscode.window.showWarningMessage(`saw could not scan ${folder.name} fully, so it is not shown as clean: ${reason}`, "See What Was Found", "Show Log")
        .then((choice) => choice && vscode.commands.executeCommand(choice === "See What Was Found" ? "saw.openVerdict" : "saw.showOutput", ...(choice === "See What Was Found" ? [{ uri: folder.uri }] : [])));
    }
  }

  private async infected(folder: vscode.WorkspaceFolder, outcome: Settled): Promise<void> {
    const count = confirmedCount(outcome);
    const what = `saw: ${folder.name} is INFECTED — ${count} confirmed finding${count === 1 ? "" : "s"}.`;
    const act = "Fix Infection in Files runs saw fix: it removes what saw confirmed from the files, pushes nothing, and runs nothing from the folder. Fixing git history is a separate step: See What Was Found explains both.";
    const choice = vscode.workspace.isTrusted
      ? await vscode.window.showErrorMessage(`${what} ${act}`, "Fix Infection in Files…", "See What Was Found")
      : await vscode.window.showWarningMessage(
          `${what} Do not trust this folder: Restricted Mode keeps its tasks and debug configurations from running. ${act}`,
          { modal: true },
          "Fix Infection in Files…",
          "See What Was Found",
        );
    if (choice === "Fix Infection in Files…") {
      await vscode.commands.executeCommand("saw.fixFolder", folder);
    } else if (choice === "See What Was Found") {
      await vscode.commands.executeCommand("saw.openVerdict", { uri: folder.uri });
    }
  }

  async engineUnavailable(engine: Extract<Engine, { kind: "unavailable" }>): Promise<void> {
    // The installer has already said why it failed and what to do; a cancel was the operator's own.
    if (this.engineWarned || engine.reason === "install-failed" || engine.reason === "install-cancelled") {
      return;
    }
    this.engineWarned = true;
    const actions =
      engine.reason === "invalid-setting" ? ["Open Setting", "Show Log"] : ["Install saw", "Show Log"];
    const choice = await vscode.window.showWarningMessage(`${engine.message} No folder was scanned.`, ...actions);
    if (choice === "Install saw") {
      await vscode.commands.executeCommand("saw.install");
    } else if (choice === "Open Setting") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "saw.path");
    } else if (choice === "Show Log") {
      await vscode.commands.executeCommand("saw.showOutput");
    }
  }

  applied(name: string, verdict?: FolderVerdict): void {
    const detail = verdict ? ` (${VERDICT_LABEL[verdict]})` : "";
    void vscode.window.showInformationMessage(`saw checked the update to ${name}${detail}. The folder was updated.`);
  }

  unheld(name: string): void {
    void vscode.window.showWarningMessage(`saw did not check a git command in ${name} before it changed the folder. The scan is of the folder as it is now.`);
  }

  /** The folder was already open, and it is not a commit saw let in. Nothing was put back. */
  notAdmitted(name: string): void {
    void vscode.window.showWarningMessage(`saw didn't check this version of ${name} before it arrived, and could not undo it. saw scanned the folder as it is now.`);
  }

  held(name: string, verdict: FolderVerdict): void {
    const message = `saw stopped an update to ${name} (${VERDICT_LABEL[verdict]}). The folder was not changed.`;
    const show = verdict === "infected" ? vscode.window.showErrorMessage : vscode.window.showWarningMessage;
    void show(message, "Full Details").then((choice) => {
      if (choice === "Full Details") {
        void vscode.commands.executeCommand("saw.openReport");
      }
    });
  }

  resetEngineWarning(): void {
    this.engineWarned = false;
  }
}
