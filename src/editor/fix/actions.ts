import * as vscode from "vscode";

import { answerLine, isAskEvent, readAsk } from "../../core/fix/ask";
import { amendArgs, auditArgs, canFix, FIX_SINCE, fixArgs, gitIdentity, hookArgs, readAudit, readAmend, readFix, readHookJson, watchStatusArgs, type FixDetails } from "../../core/fix/actions";
import { FEATURES, supports } from "../../core/capabilities";
import { describeProgress, PROGRESS_ARGS, ProgressLines } from "../../core/scan/progress";
import type { CommandRun } from "../../core/report/reports";
import { runProgram, type RunControl, type RunResult } from "../../core/run";
import { plain } from "../../core/text";
import type { Controller } from "../scan/controller";
import { openFixChanges } from "./changes";
import type { Decide } from "./decide";
import type { Engine, EngineResolver } from "../install/engine";
import type { AuditRecord, Model } from "../model";
import { VERDICT_LABEL } from "../present";
import type { Reports } from "../view/reports";
import type { Settings } from "../settings";

const LAST_AUDIT = "saw.lastAudit";
const ACTION_TIMEOUT_MS = 15 * 60_000;
/** How much of saw's own report a command's report keeps. */
const SAID_LIMIT = 1024 * 1024;

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

const HISTORY_CONSEQUENCES =
  "saw fix amend rewrites every past commit that holds the malicious code, keeping each commit's message and author, " +
  "and force-pushes each branch that held one. Anyone with a copy of those branches must reset to the new ones, " +
  "or pushing the old commits brings the infection back.\n\n" +
  "It needs admin rights on the repository, a clone that is up to date, and your git name and email. " +
  "A protected branch is not force-pushed: the fixed history is pushed beside it for a pull request. Tags and forks are only reported.\n\n" +
  "It cannot be undone with saw discard.";

/**
 * What saw does on the operator's request: fix a folder's files or its git history, audit the machine, keep its git hooks in
 * place, and read what `saw watch` has reported. Each runs in the background, and its report opens in the editor.
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
    private readonly decide: Decide,
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
    if (this.busy(folder)) {
      return;
    }
    if (state.last && state.last.verdict !== "infected" && state.last.verdict !== "incomplete") {
      void vscode.window.showInformationMessage(`saw no longer finds ${folder.name} infected (last scan: ${VERDICT_LABEL[state.last.verdict]}), so there is nothing to fix in its files.`);
      return;
    }
    const engine = await this.fixEngine();
    if (!engine) {
      return;
    }
    const identity = await gitIdentity(folder.uri.fsPath);
    const unsaved =
      identity === "missing"
        ? "\n\nGit has no name and email for this folder, so saw cannot put your uncommitted work on a branch: " +
          "it stays on disk only. To keep it on a branch, cancel and set user.name and user.email first."
        : "";
    const choice = await vscode.window.showWarningMessage(
      `Fix the infection in the files of ${folder.name}?`,
      {
        modal: true,
        detail:
          "This runs saw fix. It removes what saw confirms as malicious from the files in this folder now, together with the installed packages, " +
          "the generated build output and the lockfile, and puts the fixed files on a new local branch. " +
          "First it tries to keep what you have not committed on a local saw/uncommitted-… branch; its report says if it could not.\n\n" +
          "Nothing is pushed, and no code from this folder runs. Past commits still hold the infection: " +
          "Fix Infection in Git History (saw fix amend) is the separate step that removes it from them." +
          unsaved,
      },
      "Fix Files",
    );
    if (choice !== "Fix Files") {
      return;
    }
    this.model.setFixing(folder, true, "files");
    this.decide.clearLog();
    this.log.info(`${folder.name}: saw fix started.`);
    const report: CommandRun = { startedAt: Date.now(), said: "" };
    this.reports.fixStarted(folder, report);
    const showReport = () => void this.reports.open(this.reports.fixUri(folder));
    showReport();
    const asking = supports(engine.capabilities, FEATURES.fixAsk, "fix-ask");
    let refused = "";
    const run = await this.run(`saw fix: ${folder.name}`, engine.binary, fixArgs(folder.uri.fsPath, this.settings().configPath, engine.capabilities), ["stderr"], report, undefined, asking ? { folder, treatment: "files", refused: (cause) => (refused = cause) } : undefined);
    this.model.setFixing(folder, false);
    this.controller.request(folder, { immediate: true });
    if (refused) {
      this.reports.fixFinished(folder, undefined);
      void vscode.window.showErrorMessage(`${refused} The files fix was stopped, and ${folder.name} is scanned again now.`, "Files Fix Details").then((c) => c && showReport());
      return;
    }
    if (run.cancelled) {
      this.reports.fixFinished(folder, undefined);
      void vscode.window.showWarningMessage(`The files fix for ${folder.name} was stopped before it finished. It is scanned again now.`, "Files Fix Details").then((c) => c && showReport());
      return;
    }
    const outcome = readFix(run.stdout, run.exitCode);
    this.reports.fixFinished(folder, outcome);
    this.log.info(`${folder.name}: saw fix ${outcome.kind}${outcome.kind === "failed" ? `: ${outcome.cause}` : ""}.`);
    switch (outcome.kind) {
      case "prepared": {
        const { details } = outcome;
        const more = outcome.needsReview ? " Part of it needs you: Files Fix Details says what." : "";
        const where = details?.branch ? ` on the local branch ${plain(details.branch, 120)}` : " on a local branch";
        const cleaned = details?.partial ? `saw fixed part of the infection in the files of ${folder.name}` : `saw fixed the infection in the files of ${folder.name}`;
        const history = details?.historyHoldsPayload ? " Git history still holds it: Fix Infection in Git History is the next step." : "";
        const unsaved = unsavedWork(details);
        const notify = unsaved || details?.partial ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
        const changes = details?.branch && details.base ? { base: details.base, branch: details.branch } : undefined;
        const choice2 = await notify(
          `${cleaned} and put the fixed files${where}.${more}${unsaved ?? ""}${history} Review the change before you push it.`,
          ...(changes ? ["Open Changes"] : []),
          "Files Fix Details",
          details?.historyHoldsPayload ? "Fix Git History…" : "Source Control",
        );
        if (choice2 === "Open Changes" && changes && !(await openFixChanges(folder, changes.base, changes.branch, this.log))) {
          // The report gives the git diff command to run instead.
          showReport();
        }
        if (choice2 === "Files Fix Details") showReport();
        if (choice2 === "Source Control") await vscode.commands.executeCommand("workbench.view.scm");
        if (choice2 === "Fix Git History…") await this.amendHistory(folder);
        return;
      }
      case "skipped":
        void vscode.window.showInformationMessage(`saw confirmed nothing to remove in ${folder.name}, so it changed nothing.`);
        return;
      case "failed": {
        const choice2 = await vscode.window.showErrorMessage(`saw could not fix the files of ${folder.name}: ${plain(outcome.cause, 300)}`, "Files Fix Details");
        if (choice2) showReport();
        return;
      }
    }
  }

  /** `saw fix amend`: rewrite the past commits that hold the infection, and force-push their branches. */
  async amendHistory(target?: vscode.WorkspaceFolder): Promise<void> {
    const folder = target ?? (await this.pickFolder());
    if (!folder || this.busy(folder)) {
      return;
    }
    const engine = await this.fixEngine();
    if (!engine) {
      return;
    }
    if ((await gitIdentity(folder.uri.fsPath)) === "missing") {
      void vscode.window.showErrorMessage(`Git has no name and email for ${folder.name}, and rewritten commits need them. Set user.name and user.email, then try again.`);
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `Fix the infection in the git history of ${folder.name}?`,
      { modal: true, detail: HISTORY_CONSEQUENCES },
      "Continue…",
    );
    if (choice !== "Continue…") {
      return;
    }
    const typed = await vscode.window.showInputBox({
      title: "Fix Infection in Git History",
      prompt: `This rewrites past commits and force-pushes branches. Type ${folder.name} to go ahead.`,
      placeHolder: folder.name,
      ignoreFocusOut: true,
      validateInput: (value) => (value === folder.name ? undefined : `Type ${folder.name} exactly.`),
    });
    if (typed !== folder.name) {
      return;
    }
    this.model.setFixing(folder, true, "history");
    this.decide.clearLog();
    this.log.info(`${folder.name}: saw fix amend started.`);
    const report: CommandRun = { startedAt: Date.now(), said: "" };
    this.reports.amendStarted(folder, report);
    const showReport = () => void this.reports.open(this.reports.amendUri(folder));
    showReport();
    const asking = supports(engine.capabilities, FEATURES.fixAsk, "fix-ask");
    let refused = "";
    const run = await this.run(
      `saw fix amend: ${folder.name}`,
      engine.binary,
      amendArgs(folder.uri.fsPath, this.settings().configPath, engine.capabilities),
      ["stdout", "stderr"],
      report,
      undefined,
      asking ? { folder, treatment: "history", refused: (cause) => (refused = cause) } : undefined,
    );
    this.model.setFixing(folder, false);
    this.controller.request(folder, { immediate: true });
    const details = (c: string | undefined) => c && showReport();
    if (refused || run.cancelled) {
      this.reports.amendFinished(folder, undefined);
      const why = refused ? `${refused} ` : "";
      void vscode.window.showWarningMessage(`${why}The git history fix for ${folder.name} was stopped before it finished. Its details say what it had already done.`, "Git History Fix Details").then(details);
      return;
    }
    const outcome = readAmend(run.exitCode);
    this.reports.amendFinished(folder, outcome);
    this.log.info(`${folder.name}: saw fix amend ${outcome.kind} (exit ${String(run.exitCode)}).`);
    switch (outcome.kind) {
      case "done":
        void vscode.window
          .showInformationMessage(`saw removed the infection from the git history of ${folder.name} and force-pushed the branches that held it. Tell everyone with a clone to reset to the new branches.`, "Git History Fix Details")
          .then(details);
        return;
      case "review":
        void vscode.window.showWarningMessage(`The git history fix for ${folder.name} needs you. Its details say what.`, "Git History Fix Details").then(details);
        return;
      case "failed":
        void vscode.window.showErrorMessage(`saw could not fix the git history of ${folder.name}. Its details say why.`, "Git History Fix Details").then(details);
        return;
    }
  }

  /** Says so when a fix is already running for the folder. */
  private busy(folder: vscode.WorkspaceFolder): boolean {
    const state = this.model.get(folder);
    if (!state.fixing) {
      return false;
    }
    const which = state.treating === "history" ? "the infection in its git history" : "the infection in its files";
    void vscode.window.showInformationMessage(`saw is already fixing ${which} for ${folder.name}.`);
    return true;
  }

  /** A saw that can fix from the editor, or undefined once the operator has been told why not. */
  private async fixEngine(): Promise<Extract<Engine, { kind: "ready" }> | undefined> {
    const engine = await this.engines.resolve();
    this.model.setEngine(engine);
    if (engine.kind !== "ready") {
      void vscode.window.showWarningMessage(engine.message);
      return undefined;
    }
    if (!canFix(engine.version, engine.capabilities)) {
      const update = await vscode.window.showWarningMessage(`saw ${engine.version} is too old to fix an infection from the editor; it needs ${FIX_SINCE} or later.`, "Install or Repair saw");
      if (update) {
        await vscode.commands.executeCommand("saw.install");
      }
      return undefined;
    }
    return engine;
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
          .showErrorMessage(`Do not change any password or token yet.${said} Act on the details first.`, "Details")
          .then(show);
        return;
      case "incomplete":
        void vscode.window
          .showWarningMessage(`saw could not read all of this machine, so changing passwords is not known to be safe.${said}`, "Details")
          .then(show);
        return;
      case "to-confirm":
        void vscode.window
          .showWarningMessage(`Confirm that the items saw lists are yours before you change any password or token.${said}`, "Details")
          .then(show);
        return;
      case "no-hazard":
        void vscode.window
          .showInformationMessage(said.trim() || "saw found nothing that makes changing passwords unsafe.", "Details")
          .then(show);
        return;
      case "failed":
        void vscode.window.showErrorMessage("The check did not finish, so this machine was not checked.", "Details").then(show);
        return;
    }
  }

  /** Read `saw watch status` and open it as a report. This does not put the watcher in place. */
  async openWatchReport(): Promise<void> {
    const showReport = () => void this.reports.open(this.reports.machineUri("watch"));
    if (this.model.machine.readingWatch) {
      showReport();
      return;
    }
    const engine = await this.ready();
    if (!engine) {
      return;
    }
    this.model.setMachine({ readingWatch: true });
    const report: CommandRun = { startedAt: Date.now(), said: "" };
    this.reports.watchStarted(report);
    showReport();
    const run = await this.run("saw watch status", engine.binary, watchStatusArgs(), ["stdout", "stderr"], report);
    this.model.setMachine({ readingWatch: false });
    if (run.cancelled) {
      return;
    }
    const line = report.said.split("\n").map((part) => part.trim()).find(Boolean);
    if (line) {
      this.model.setMachine({ watch: { line: plain(line, 400), at: Date.now() } });
    }
    this.reports.watchFinished();
    this.log.info(`saw watch status: ${plain(line ?? "", 300)}`);
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
      void vscode.window.showInformationMessage("Checks on clone and pull are on: every clone, pull and branch switch is scanned.");
    } else {
      void vscode.window.showWarningMessage("Checks on clone and pull are not fully working. The details say why.", "Details").then((c) => c && showReport());
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
    ask?: { folder: vscode.WorkspaceFolder; treatment: "files" | "history"; refused: (cause: string) => void },
  ): Thenable<RunResult> {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (notification, token) => {
      const abort = new AbortController();
      const cancelled = token.onCancellationRequested(() => {
        abort.abort();
        this.decide.cancel();
      });
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
      let control: RunControl | undefined;
      let partial = "";
      let tail = Promise.resolve();
      let closed = false;
      const handleLine = async (line: string) => {
        if (!ask || !isAskEvent(line)) {
          collect(`${line}\n`);
          return;
        }
        if (closed) {
          return;
        }
        const read = readAsk(line);
        if (!read || "refused" in read) {
          ask.refused(read && "refused" in read ? read.refused : "saw asked a question this extension cannot read");
          abort.abort();
          return;
        }
        if (!control) {
          ask.refused("saw asked a question before this extension could answer");
          abort.abort();
          return;
        }
        control.hold(true);
        try {
          if (this.decide.repeated(read.id)) {
            this.reports.fixDecisions(ask.folder, this.decide.lines(), ask.treatment);
          }
          const decision = await this.decide.ask(ask.folder, read, ask.treatment);
          if (decision === "stop" || abort.signal.aborted || closed) {
            return;
          }
          const answer = answerLine(read, decision);
          if (!answer) {
            return;
          }
          control.writeLine(answer);
          this.reports.fixDecisions(ask.folder, this.decide.lines(), ask.treatment);
        } finally {
          control.hold(false);
        }
      };
      const feed = (chunk: string) => {
        const lines = (partial + chunk).split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) {
          tail = tail.then(() => handleLine(line));
        }
      };
      try {
        const result = await runProgram(binary, args, {
          timeoutMs: ACTION_TIMEOUT_MS,
          signal: abort.signal,
          input: ask !== undefined,
          onReady: (ready) => {
            control = ready;
          },
          onOutput: (text, stream) => {
            if (ask && stream === "stderr") {
              feed(text);
            } else if (events && stream === "stderr") {
              events.feed(text);
            } else if (streams.includes(stream)) {
              collect(text);
            }
          },
        });
        closed = true;
        this.decide.cancel();
        if (partial && !isAskEvent(partial)) {
          collect(partial);
        }
        partial = "";
        await tail;
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
        this.decide.cancel();
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
    return (await vscode.window.showQuickPick(choices, { placeHolder: "Folder to fix" }))?.folder;
  }
}