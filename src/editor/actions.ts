import * as vscode from "vscode";

import {
  AUDIT_ARGS,
  auditVerdict,
  canFix,
  FIX_SINCE,
  fixArgs,
  gitIdentity,
  HOOK_STATUS_ARGS,
  readFix,
  readHookStatus,
  rotationSentence,
} from "../core/actions";
import type { CommandRun } from "../core/reports";
import { runProgram, type RunResult } from "../core/run";
import { plain } from "../core/text";
import type { Controller } from "./controller";
import type { EngineResolver } from "./engine";
import type { AuditRecord, Model } from "./model";
import { VERDICT_LABEL } from "./present";
import type { Reports } from "./reports";
import type { Settings } from "./settings";

const LAST_AUDIT = "saw.lastAudit";
const ACTION_TIMEOUT_MS = 15 * 60_000;
/** How much of saw's own report a command's report keeps. */
const SAID_LIMIT = 1024 * 1024;

/**
 * What saw does on the operator's request: fix a folder, audit the machine, keep its git hooks in
 * place. Each runs in the background behind a progress notification, and its report opens in the editor.
 */
export class Actions {
  constructor(
    private readonly model: Model,
    private readonly engines: EngineResolver,
    private readonly controller: Controller,
    private readonly settings: () => Settings,
    private readonly log: vscode.LogOutputChannel,
    private readonly memento: vscode.Memento,
    private readonly reports: Reports,
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
    const identity = await gitIdentity(folder.uri.fsPath);
    const unsaved =
      identity === "missing"
        ? "\n\nGit has no name and email for this folder, so saw cannot put your uncommitted work on a branch: " +
          "it stays on disk only. To keep it on a branch, cancel and set user.name and user.email first."
        : "";
    const choice = await vscode.window.showWarningMessage(
      `Fix ${folder.name} with saw?`,
      {
        modal: true,
        detail:
          "saw removes what it confirms as malicious from this checkout, together with the installed packages, " +
          "the generated build output and the lockfile, and prepares the clean-up on a new local branch. " +
          "First it tries to keep what you have not committed on a local saw/uncommitted-… branch; its report says if it could not. " +
          "Nothing is pushed or published, and no code from this folder runs." +
          unsaved,
      },
      "Fix",
    );
    if (choice !== "Fix") {
      return;
    }
    this.model.setFixing(folder, true);
    this.log.info(`${folder.name}: saw fix started.`);
    const report: CommandRun = { startedAt: Date.now(), said: "" };
    this.reports.fixStarted(folder, report);
    const showReport = () => void this.reports.open(this.reports.fixUri(folder));
    showReport();
    const run = await this.run(`saw fix: ${folder.name}`, engine.binary, fixArgs(folder.uri.fsPath, this.settings().configPath), ["stderr"], report);
    this.model.setFixing(folder, false);
    this.controller.request(folder, { immediate: true });
    if (run.cancelled) {
      this.reports.fixFinished(folder, undefined);
      void vscode.window.showWarningMessage(`saw fix was stopped before it finished ${folder.name}. It is scanned again now.`, "Show Report").then((c) => c && showReport());
      return;
    }
    const outcome = readFix(run.stdout, run.exitCode);
    this.reports.fixFinished(folder, outcome);
    this.log.info(`${folder.name}: saw fix ${outcome.kind}${outcome.kind === "failed" ? `: ${outcome.cause}` : ""}.`);
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
    const showReport = () => void this.reports.open(this.reports.machineUri("audit"));
    if (this.model.machine.auditing) {
      showReport();
      return;
    }
    const binary = await this.binary();
    if (!binary) {
      return;
    }
    this.model.setMachine({ auditing: true });
    const report: CommandRun = { startedAt: Date.now(), said: "" };
    this.reports.auditStarted(report);
    showReport();
    const run = await this.run("saw audit", binary, AUDIT_ARGS, ["stdout", "stderr"], report);
    this.model.setMachine({ auditing: false });
    if (run.cancelled) {
      return;
    }
    const audit: AuditRecord = { verdict: auditVerdict(run.exitCode), sentence: rotationSentence(run.stdout), at: Date.now() };
    this.model.setMachine({ audit });
    this.reports.auditFinished();
    await this.memento.update(LAST_AUDIT, audit);
    this.log.info(`saw audit: ${audit.verdict}${audit.sentence ? ` — ${audit.sentence}` : ""}`);
    const said = audit.sentence ? ` ${plain(audit.sentence, 400)}` : "";
    const show = (choice: string | undefined) => choice && showReport();
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
    const report: CommandRun = { startedAt: Date.now(), said: "" };
    this.reports.hooksChangeStarted(subcommand, report);
    const showReport = () => void this.reports.open(this.reports.machineUri("hooks"));
    showReport();
    await this.run(`saw hook ${subcommand}`, binary, ["hook", subcommand, "--no-stream"], ["stdout", "stderr"], report);
    await this.refreshHooks();
    const hooks = this.model.machine.hooks;
    if (hooks?.kind === "installed" && !hooks.problems.length) {
      void vscode.window.showInformationMessage("saw's scan-on-clone hooks are in place: clones, pulls and branch switches are scanned.");
    } else {
      void vscode.window.showWarningMessage("saw's scan-on-clone hooks are not fully in place. saw's report says why.", "Show Report").then((c) => c && showReport());
    }
  }

  /** Run saw in the background, collecting its own report from `streams` into `report` as it comes. */
  private run(title: string, binary: string, args: readonly string[], streams: ReadonlyArray<"stdout" | "stderr">, report: CommandRun): Thenable<RunResult> {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (_progress, token) => {
      const abort = new AbortController();
      const cancelled = token.onCancellationRequested(() => abort.abort());
      try {
        const result = await runProgram(binary, args, {
          timeoutMs: ACTION_TIMEOUT_MS,
          signal: abort.signal,
          onOutput: (text, stream) => {
            if (streams.includes(stream) && report.said.length < SAID_LIMIT) {
              report.said += text;
              this.reports.progressed();
            }
          },
        });
        report.finishedAt = Date.now();
        const stopped = result.cancelled ? "cancelled" : result.timedOut ? "timed-out" : result.spawnError ? "not-started" : undefined;
        if (stopped) {
          report.stopped = stopped;
        }
        if (result.spawnError) {
          report.detail = result.spawnError;
        }
        this.reports.progressed();
        return result;
      } finally {
        cancelled.dispose();
      }
    });
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