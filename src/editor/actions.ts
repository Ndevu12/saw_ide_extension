import * as vscode from "vscode";

import { auditArgs, canFix, FIX_SINCE, fixArgs, gitIdentity, hookArgs, readAudit, readFix, readHookJson, type FixDetails } from "../core/actions";
import { FEATURES, supports } from "../core/capabilities";
import { describeProgress, PROGRESS_ARGS, ProgressLines } from "../core/progress";
import type { CommandRun } from "../core/reports";
import { runProgram, type RunResult } from "../core/run";
import { plain } from "../core/text";
import type { Controller } from "./controller";
import { openFixChanges } from "./changes";
import type { Engine, EngineResolver } from "./engine";
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
/** A warning when saw could not keep the operator's uncommitted work on a branch. */
function unsavedWork(details: FixDetails | undefined): string | undefined {
  const work = details?.uncommitted;
  if (!work || (work.branch && !work.unsaved)) {
    return undefined;
  }
  return work.branch
    ? ` ${work.unsaved} uncommitted file(s) could not be saved on ${plain(work.branch, 120)} and are on disk only.`
    : ` Your uncommitted work could not be saved on a branch${work.reason ? ` (${plain(work.reason, 200)})` : ""}: it is on disk only.`;
}

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

  private async ready(): Promise<Extract<Engine, { kind: "ready" }> | undefined> {
    const engine = await this.engines.resolve();
    this.model.setEngine(engine);
    if (engine.kind === "ready") {
      return engine;
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
    if (!canFix(engine.version, engine.capabilities)) {
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
        const { details } = outcome;
        const more = outcome.needsReview ? " Part of it needs you: the report says what." : "";
        const where = details?.branch ? ` on the local branch ${plain(details.branch, 120)}` : " on a local branch";
        const cleaned = details?.partial ? `saw cleaned part of ${folder.name}` : `saw cleaned ${folder.name}`;
        const unsaved = unsavedWork(details);
        const notify = unsaved || details?.partial ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
        const changes = details?.branch && details.base ? { base: details.base, branch: details.branch } : undefined;
        const choice2 = await notify(
          `${cleaned} and prepared the clean-up${where}.${more}${unsaved ?? ""} Review the change before you push it.`,
          ...(changes ? ["Open Changes"] : []),
          "Show Report",
          "Source Control",
        );
        if (choice2 === "Open Changes" && changes && !(await openFixChanges(folder, changes.base, changes.branch, this.log))) {
          // The report gives the git diff command to run instead.
          showReport();
        }
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
    const engine = await this.ready();
    if (!engine) {
      return;
    }
    this.model.setMachine({ auditing: true });
    const report: CommandRun = { startedAt: Date.now(), said: "" };
    this.reports.auditStarted(report);
    showReport();
    const json = supports(engine.capabilities, FEATURES.auditJson, "audit");
    // With progress on, saw keeps its human report off stderr; JSON carries what the report shows instead.
    const progress = json && supports(engine.capabilities, FEATURES.progress);
    const args = [...auditArgs(engine.capabilities), ...(progress ? PROGRESS_ARGS : [])];
    const onProgress = progress ? (text: string | undefined) => this.model.setMachine({ auditProgress: text }) : undefined;
    const run = await this.run("saw audit", engine.binary, args, json ? ["stderr"] : ["stdout", "stderr"], report, onProgress);
    this.model.setMachine({ auditing: false, auditProgress: undefined });
    if (run.cancelled) {
      return;
    }
    const audit: AuditRecord = { ...readAudit(run.stdout, run.stderr, run.exitCode, json), at: Date.now() };
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
      case "to-confirm":
        void vscode.window
          .showWarningMessage(`saw audit: confirm that the items saw lists are yours before you change any password or token.${said}`, "Show Report")
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
    const run = await runProgram(engine.binary, hookArgs("status", engine.capabilities), { timeoutMs: 30_000, maxOutputBytes: 256 * 1024 });
    const hooks = readHookJson(run.stdout, run.stderr, run.exitCode);
    this.log.info(`scan-on-clone hooks: ${hooks.kind}${hooks.kind === "installed" && hooks.problems.length ? ` (${hooks.problems.length} problem(s))` : ""}`);
    this.model.setMachine({ hooks });
  }

  async hooks(subcommand: "install" | "repair"): Promise<void> {
    const engine = await this.ready();
    if (!engine) {
      return;
    }
    const report: CommandRun = { startedAt: Date.now(), said: "" };
    this.reports.hooksChangeStarted(subcommand, report);
    const showReport = () => void this.reports.open(this.reports.machineUri("hooks"));
    showReport();
    const json = supports(engine.capabilities, FEATURES.hookStatusJson, "hook-status");
    const run = await this.run(`saw hook ${subcommand}`, engine.binary, hookArgs(subcommand, engine.capabilities), json ? ["stderr"] : ["stdout", "stderr"], report);
    // With --json, install and repair print the status as it stands after their change.
    const after = json && !run.cancelled ? readHookJson(run.stdout, run.stderr, run.exitCode) : undefined;
    if (after && after.kind !== "unknown") {
      this.model.setMachine({ hooks: after });
    } else {
      await this.refreshHooks();
    }
    const hooks = this.model.machine.hooks;
    if (hooks?.kind === "installed" && !hooks.problems.length) {
      void vscode.window.showInformationMessage("saw's scan-on-clone hooks are in place: clones, pulls and branch switches are scanned.");
    } else {
      void vscode.window.showWarningMessage("saw's scan-on-clone hooks are not fully in place. saw's report says why.", "Show Report").then((c) => c && showReport());
    }
  }

  /**
   * Run saw in the background, collecting its own report from `streams` into `report` as it comes.
   * With `onProgress`, saw was asked for `--progress=jsonl`: its events go to the notification and
   * `onProgress`, and only the rest of stderr into the report.
   */
  private run(
    title: string,
    binary: string,
    args: readonly string[],
    streams: ReadonlyArray<"stdout" | "stderr">,
    report: CommandRun,
    onProgress?: (text: string | undefined) => void,
  ): Thenable<RunResult> {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (notification, token) => {
      const abort = new AbortController();
      const cancelled = token.onCancellationRequested(() => abort.abort());
      const collect = (text: string) => {
        if (report.said.length < SAID_LIMIT) {
          report.said += text;
          this.reports.progressed();
        }
      };
      const events =
        onProgress &&
        new ProgressLines((progress) => {
          const text = progress ? describeProgress(progress) : undefined;
          onProgress(text);
          notification.report({ message: text ?? "" });
        }, collect);
      try {
        const result = await runProgram(binary, args, {
          timeoutMs: ACTION_TIMEOUT_MS,
          signal: abort.signal,
          onOutput: (text, stream) => {
            if (events && stream === "stderr") {
              events.feed(text);
            } else if (streams.includes(stream)) {
              collect(text);
            }
          },
        });
        events?.end();
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