import * as vscode from "vscode";

import {
  AUDIT_ARGS,
  auditVerdict,
  canFix,
  FIX_SINCE,
  fixArgs,
  HOOK_STATUS_ARGS,
  readFix,
  readHookStatus,
  rotationSentence,
} from "../core/actions";
import { runProgram } from "../core/run";
import { plain } from "../core/text";
import type { Controller } from "./controller";
import type { EngineResolver } from "./engine";
import type { AuditRecord, Model } from "./model";
import { VERDICT_LABEL } from "./present";
import type { Settings } from "./settings";
import { runInTerminal } from "./terminal";

const LAST_AUDIT = "saw.lastAudit";
const ACTION_TIMEOUT_MS = 15 * 60_000;

/** What saw does on the operator's request: fix a folder, audit the machine, keep its git hooks in place. */
export class Actions {
  private auditTerminal: vscode.Terminal | undefined;

  constructor(
    private readonly model: Model,
    private readonly engines: EngineResolver,
    private readonly controller: Controller,
    private readonly settings: () => Settings,
    private readonly log: vscode.LogOutputChannel,
    private readonly memento: vscode.Memento,
  ) {
    const audit = memento.get<AuditRecord>(LAST_AUDIT);
    if (audit) {
      model.setMachine({ audit });
    }
  }

  private async binary(): Promise<string | undefined> {
    const engine = await this.engines.resolve();
    this.model.setEngine(engine);
    if (engine.kind === "ready") {
      return engine.binary;
    }
    void vscode.window.showWarningMessage(engine.message);
    return undefined;
  }

  async fixFolder(target?: vscode.WorkspaceFolder): Promise<void> {
    const folder = target ?? (await this.pickFolder());
    if (!folder) {
      return;
    }
    const state = this.model.get(folder);
    if (state.fixing) {
      void vscode.window.showInformationMessage(`saw is already fixing ${folder.name}.`);
      return;
    }
    if (state.last && state.last.verdict !== "infected" && state.last.verdict !== "incomplete") {
      void vscode.window.showInformationMessage(`saw no longer finds ${folder.name} infected (last scan: ${VERDICT_LABEL[state.last.verdict]}), so there is nothing to fix.`);
      return;
    }
    const engine = await this.engines.resolve();
    this.model.setEngine(engine);
    if (engine.kind !== "ready") {
      void vscode.window.showWarningMessage(engine.message);
      return;
    }
    if (!canFix(engine.version)) {
      const update = await vscode.window.showWarningMessage(
        `saw ${engine.version} is too old to fix a folder from the editor; it needs ${FIX_SINCE} or later.`,
        "Install or Repair saw",
      );
      if (update) {
        await vscode.commands.executeCommand("saw.install");
      }
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `Fix ${folder.name} with saw?`,
      {
        modal: true,
        detail:
          "saw removes what it confirms as malicious from this checkout, together with the installed packages, " +
          "the generated build output and the lockfile, and prepares the clean-up on a new local branch. " +
          "What you have not committed is kept on a local saw/uncommitted-… branch first. " +
          "Nothing is pushed or published, and no code from this folder runs.",
      },
      "Fix",
    );
    if (choice !== "Fix") {
      return;
    }
    this.model.setFixing(folder, true);
    this.log.info(`${folder.name}: saw fix started.`);
    const { terminal, result } = this.run(`saw fix: ${folder.name}`, engine.binary, fixArgs(folder.uri.fsPath, this.settings().configPath), ["stderr"]);
    const run = await result;
    this.model.setFixing(folder, false);
    this.controller.request(folder, { immediate: true });
    if (run.cancelled) {
      void vscode.window.showWarningMessage(`saw fix was stopped before it finished ${folder.name}. It is scanned again now.`);
      return;
    }
    const outcome = readFix(run.stdout, run.exitCode);
    this.log.info(`${folder.name}: saw fix ${outcome.kind}${outcome.kind === "failed" ? `: ${outcome.cause}` : ""}.`);
    const showReport = () => terminal.show();
    switch (outcome.kind) {
      case "prepared": {
        const more = outcome.needsReview ? " Part of it needs you: the report says what." : "";
        const choice2 = await vscode.window.showInformationMessage(
          `saw cleaned ${folder.name} and prepared the clean-up on a local branch.${more} Review the change before you push it.`,
          "Show Report",
          "Source Control",
        );
        if (choice2 === "Show Report") showReport();
        if (choice2 === "Source Control") await vscode.commands.executeCommand("workbench.view.scm");
        return;
      }
      case "skipped":
        void vscode.window.showInformationMessage(`saw confirmed nothing to remove in ${folder.name}, so it changed nothing.`);
        return;
      case "failed": {
        const choice2 = await vscode.window.showErrorMessage(`saw could not fix ${folder.name}: ${plain(outcome.cause, 300)}`, "Show Report");
        if (choice2) showReport();
        return;
      }
    }
  }

  async auditMachine(): Promise<void> {
    if (this.model.machine.auditing) {
      this.auditTerminal?.show();
      return;
    }
    const binary = await this.binary();
    if (!binary) {
      return;
    }
    this.model.setMachine({ auditing: true });
    const { terminal, result } = this.run("saw audit", binary, AUDIT_ARGS, ["stdout", "stderr"]);
    this.auditTerminal = terminal;
    const run = await result;
    this.model.setMachine({ auditing: false });
    if (run.cancelled) {
      return;
    }
    const audit: AuditRecord = { verdict: auditVerdict(run.exitCode), sentence: rotationSentence(run.stdout), at: Date.now() };
    this.model.setMachine({ audit });
    await this.memento.update(LAST_AUDIT, audit);
    this.log.info(`saw audit: ${audit.verdict}${audit.sentence ? ` — ${audit.sentence}` : ""}`);
    const said = audit.sentence ? ` ${plain(audit.sentence, 400)}` : "";
    const show = (choice: string | undefined) => choice && terminal.show();
    switch (audit.verdict) {
      case "rotation-unsafe":
        void vscode.window
          .showErrorMessage(`saw audit: do not change any password or token yet.${said} Act on the report first.`, "Show Report")
          .then(show);
        return;
      case "incomplete":
        void vscode.window
          .showWarningMessage(`saw audit could not read all of this machine, so changing credentials is not known to be safe.${said}`, "Show Report")
          .then(show);
        return;
      case "no-hazard":
        void vscode.window
          .showInformationMessage(said.trim() || "saw audit found nothing that makes changing credentials unsafe.", "Show Report")
          .then(show);
        return;
      case "failed":
        void vscode.window.showErrorMessage("saw audit did not finish, so this machine was not checked.", "Show Report").then(show);
        return;
    }
  }

  /** Ask saw whether its scan-on-clone hooks are in place. Quiet: the saw view shows the answer. */
  async refreshHooks(): Promise<void> {
    const engine = await this.engines.resolve();
    if (engine.kind !== "ready") {
      return;
    }
    const run = await runProgram(engine.binary, HOOK_STATUS_ARGS, { timeoutMs: 30_000, maxOutputBytes: 256 * 1024 });
    const hooks = readHookStatus(`${run.stdout}\n${run.stderr}`, run.exitCode);
    this.log.info(`scan-on-clone hooks: ${hooks.kind}${hooks.kind === "installed" && hooks.problems.length ? ` (${hooks.problems.length} problem(s))` : ""}`);
    this.model.setMachine({ hooks });
  }

  async hooks(subcommand: "install" | "repair"): Promise<void> {
    const binary = await this.binary();
    if (!binary) {
      return;
    }
    const { result } = this.run(`saw hook ${subcommand}`, binary, ["hook", subcommand, "--no-stream"], ["stdout", "stderr"]);
    await result;
    await this.refreshHooks();
    const hooks = this.model.machine.hooks;
    if (hooks?.kind === "installed" && !hooks.problems.length) {
      void vscode.window.showInformationMessage("saw's scan-on-clone hooks are in place: clones, pulls and branch switches are scanned.");
    } else {
      void vscode.window.showWarningMessage("saw's scan-on-clone hooks are not fully in place. The report in the terminal says why.");
    }
  }

  private run(name: string, binary: string, args: readonly string[], show: ReadonlyArray<"stdout" | "stderr">) {
    return runInTerminal(name, binary, args, { show, timeoutMs: ACTION_TIMEOUT_MS });
  }

  private async pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length <= 1) {
      return folders[0];
    }
    const infected = folders.filter((folder) => this.model.get(folder).last?.verdict === "infected");
    const choices = (infected.length ? infected : folders).map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder }));
    return (await vscode.window.showQuickPick(choices, { placeHolder: "Folder for saw to fix" }))?.folder;
  }
}