import { mkdirSync, readFileSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import * as nodePath from "node:path";

import * as vscode from "vscode";

import { FEATURES, supports, type Capabilities } from "../../core/capabilities";
import { mayRelease, offersGovernRestore, offersGovernVerdict, openAdmission, readGoverned, readNotice, readRestore, restoreArgs, shouldRestore, unheldAfter, verdictArgs, type Governed, type GovernedReading, type GovernNotice } from "../../core/govern/contract";
import { governStatusDir } from "../../core/govern/places";
import { behindVersion } from "../../core/install/upgrade";
import { runProgram } from "../../core/run";
import type { Controller } from "../scan/controller";
import type { Installer } from "../install/installer";
import type { Model } from "../model";
import type { Settings } from "../settings";
import type { Alerts } from "../view/alerts";
import { TerminalLetIn, type LetInChannel } from "./letIn";
import { Placement } from "./placement";
import { GitViewQuestions } from "./questions";

type UnheldFrom = "command" | "open" | "let-in";

/**
 * When saw can check an update before it lands, put saw's check in front of git and gh for open
 * folders, and show what saw says about each folder.
 */
export class Governor implements vscode.Disposable {
  private readonly placement: Placement;
  private readonly questions: GitViewQuestions;
  private readonly seen = new Map<string, string>();
  /** The held update already shown for a folder, so its details arriving does not show it again. */
  private readonly heldShown = new Map<string, number>();
  /** When saw last said it is checking a folder, until it says how that check ended. */
  private readonly checkingSince = new Map<string, number>();
  private readonly gitMarks = new Map<string, string>();
  /** Folders already asked, once per saw binary, for this window. */
  private readonly askedOpen = new Set<string>();
  /** A folder whose open verdict is running, so its restore does not start a second one. */
  private readonly admitting = new Set<string>();
  /** A folder saw is putting back for this window, so a watcher does not scan a half-written tree. */
  private readonly restoring = new Set<string>();
  private statusWatcher: FSWatcher | undefined;
  private sawBinary = "";
  private verdictReady = false;
  private restoreReady = false;
  private statusDir = "";
  private active = false;
  private covered = false;
  private starting = false;
  private pending = false;

  constructor(
    context: vscode.ExtensionContext,
    private readonly model: Model,
    private readonly controller: Controller,
    installer: Installer,
    private readonly alerts: Alerts,
    private readonly settings: () => Settings,
    private readonly log: vscode.LogOutputChannel,
    private readonly letInChannel: LetInChannel = new TerminalLetIn(),
  ) {
    this.placement = new Placement(context, installer, log);
    this.questions = new GitViewQuestions(
      nodePath.join(context.globalStorageUri.fsPath, "govern", "questions"),
      (folder) => model.get(folder).held?.verdict,
      log,
    );
    context.subscriptions.push(
      model.onDidChange(() => this.refresh()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.forgetClosed();
        this.refresh();
      }),
    );
    this.refresh();
  }

  /**
   * A `.git/HEAD` or `ORIG_HEAD` change while saw was not checking the folder. The folder already
   * changed; the scan that follows is of what landed. When saw can say whether it let this tree
   * in, that answer decides the Chat line.
   */
  missed(uri: vscode.Uri): void {
    if (!this.active || this.claim(uri)) {
      return;
    }
    const name = nodePath.basename(uri.fsPath);
    if (name !== "HEAD" && name !== "ORIG_HEAD") {
      return;
    }
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder || this.admitting.has(folder.uri.fsPath) || !this.gitMoved(uri.fsPath)) {
      return;
    }
    if (!this.verdictReady || !this.sawBinary) {
      this.applyUnheld(folder, undefined);
      return;
    }
    void this.askVerdict(folder);
  }

  private applyUnheld(folder: vscode.WorkspaceFolder, answer: Governed | undefined, from: UnheldFrom = "command"): void {
    const decision = unheldAfter(answer, this.covered);
    if (decision === "clear") {
      this.model.setUnheld(folder, false);
      return;
    }
    if (decision === "mark") {
      this.model.setUnheld(folder, true, from);
      if (from === "let-in") {
        this.alerts.letIn(folder.name);
      } else if (from === "open") {
        this.alerts.notAdmitted(folder.name);
      } else {
        this.alerts.unheld(folder.name);
      }
    }
  }

  private async askVerdict(folder: vscode.WorkspaceFolder): Promise<void> {
    const reading = await this.verdictOf(folder);
    const code = reading?.code;
    const answer = reading?.answer ?? "could-not-answer";
    if (answer === "let-in" || code === "let-in") {
      this.applyUnheld(folder, "let-in");
      return;
    }
    if (code === "let-in-by-you") {
      this.applyUnheld(folder, "not-let-in", "let-in");
      return;
    }
    if (shouldRestore(code, this.restoreReady) && await this.putBack(folder)) {
      this.applyUnheld(folder, "let-in");
      return;
    }
    this.applyUnheld(folder, code === "could-not-answer" ? "could-not-answer" : answer);
  }

  /** Ask saw to put the folder back. Saw keeps uncommitted work and writes the check record. */
  private async putBack(folder: vscode.WorkspaceFolder): Promise<boolean> {
    const run = await runProgram(this.sawBinary, restoreArgs(folder.uri.fsPath), {
      timeoutMs: this.settings().timeoutMs,
      maxOutputBytes: 64 * 1024,
    });
    if (run.timedOut || run.spawnError || run.cancelled) {
      return false;
    }
    return readRestore(run.stdout).restored;
  }

  /** True while saw is changing this folder, so a watcher does not scan a half-written tree. */
  claim(uri: vscode.Uri): boolean {
    if (!this.active) {
      return false;
    }
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder || folder.uri.scheme !== "file") {
      return false;
    }
    const repo = nodePath.resolve(folder.uri.fsPath);
    if (this.restoring.has(repo)) {
      return true;
    }
    const since = this.checkingSince.get(repo);
    return since !== undefined && Date.now() - since <= this.settings().timeoutMs;
  }

  private refresh(): void {
    const engine = this.model.engine;
    const ready = engine?.kind === "ready" ? engine : undefined;
    const wanted = this.settings().governUpdates && !!ready && supports(ready.capabilities, FEATURES.govern, "govern");
    if (!wanted || !ready) {
      if (engine && engine.kind !== "installing") {
        this.active = false;
        this.covered = false;
        void this.placement.remove().catch((error: unknown) => {
          this.log.error(`saw could not stop checking git commands: ${String(error)}`);
        });
      }
      return;
    }
    if (this.starting) {
      this.pending = true;
      return;
    }
    this.starting = true;
    void this.enable(ready.binary, ready.capabilities).catch((error: unknown) => {
      this.log.error(`saw could not start checking git commands: ${String(error)}`);
    }).finally(() => {
      this.starting = false;
      if (this.pending) {
        this.pending = false;
        this.refresh();
      }
    });
  }

  private async enable(saw: string, capabilities: Capabilities): Promise<void> {
    const first = !this.active || saw !== this.sawBinary;
    this.sawBinary = saw;
    this.statusDir = governStatusDir(process.env["XDG_STATE_HOME"], homedir());
    if (first) {
      const help = await this.governHelp(saw);
      this.verdictReady = offersGovernVerdict(help);
      this.restoreReady = offersGovernRestore(help);
    }
    const questions = supports(capabilities, FEATURES.governQuestions) && this.questions.start() ? this.questions.dir : undefined;
    this.covered = await this.placement.place(saw, capabilities.gitStandin, questions);
    this.active = true;
    this.watchStatus();
    await this.askOpenFolders();
    await this.placement.coverGitView();
  }

  /**
   * Ask whether saw let each open folder in, once per saw for this window. A restore finishes
   * before the Git view is pointed at saw's check, because that step can reload the window.
   */
  private async askOpenFolders(): Promise<void> {
    if (!this.verdictReady || !this.sawBinary) {
      return;
    }
    this.forgetClosed();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== "file") {
        continue;
      }
      const key = `${this.sawBinary}\0${folder.uri.fsPath}`;
      if (this.askedOpen.has(key)) {
        continue;
      }
      this.askedOpen.add(key);
      await this.askOpen(folder);
    }
  }

  private async askOpen(folder: vscode.WorkspaceFolder): Promise<void> {
    const repo = folder.uri.fsPath;
    this.admitting.add(repo);
    const shown = !this.model.get(folder).checking;
    if (shown) {
      this.model.setChecking(folder, undefined, "admission");
    }
    try {
      const reading = await this.verdictOf(folder);
      const decision = openAdmission(reading, this.restoreReady);
      const restored = decision === "restore" ? await this.restoreOpen(folder) : false;
      if (shown && this.model.get(folder).checkAbout === "admission") {
        this.model.clearChecking(folder);
      }
      if (decision === "clear" || (decision === "restore" && restored)) {
        this.applyUnheld(folder, "let-in", "open");
      } else if (decision === "mark" || decision === "restore") {
        this.applyUnheld(folder, "not-let-in", reading?.code === "let-in-by-you" ? "let-in" : "open");
      }
      if (decision === "restore" && restored) {
        this.controller.request(folder, { immediate: true });
      }
    } catch (error) {
      this.log.warn(`saw could not check whether it let ${folder.name} in: ${String(error)}`);
    } finally {
      this.admitting.delete(repo);
      if (shown && this.model.get(folder).checkAbout === "admission") {
        this.model.clearChecking(folder);
      }
    }
  }

  /** Put the folder back while no watcher scans the half-written tree, then record HEAD. */
  private async restoreOpen(folder: vscode.WorkspaceFolder): Promise<boolean> {
    const repo = nodePath.resolve(folder.uri.fsPath);
    this.restoring.add(repo);
    try {
      return await this.putBack(folder);
    } finally {
      this.seedGit(folder.uri.fsPath);
      this.restoring.delete(repo);
    }
  }

  private async verdictOf(folder: vscode.WorkspaceFolder): Promise<GovernedReading | undefined> {
    const run = await runProgram(this.sawBinary, verdictArgs(folder.uri.fsPath), {
      timeoutMs: this.settings().timeoutMs,
      maxOutputBytes: 64 * 1024,
    });
    if (run.timedOut || run.spawnError || run.cancelled) {
      return undefined;
    }
    return readGoverned(run.stdout);
  }

  /** The restore's HEAD is the one this window has now, so a later watcher does not call it unheld. */
  private seedGit(folder: string): void {
    for (const name of ["HEAD", "ORIG_HEAD"]) {
      const file = nodePath.join(folder, ".git", name);
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        text = "";
      }
      this.gitMarks.set(file, text);
    }
  }

  private forgetClosed(): void {
    const open = new Set(this.folders());
    for (const key of this.askedOpen) {
      const folder = key.slice(key.indexOf("\0") + 1);
      if (!open.has(folder)) {
        this.askedOpen.delete(key);
      }
    }
  }

  private folders(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === "file").map((folder) => folder.uri.fsPath);
  }

  private async governHelp(saw: string): Promise<string> {
    const help = await runProgram(saw, ["govern", "-h"], { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
    return `${help.stdout}\n${help.stderr}`;
  }

  private letIn(folder: vscode.WorkspaceFolder): void {
    if (!this.sawBinary) {
      this.log.error(`saw could not let the update into ${folder.name}: saw is not ready.`);
      void vscode.window.showErrorMessage(`saw could not let the update into ${folder.name}: saw is not ready.`, "Show Log")
        .then((choice) => choice && vscode.commands.executeCommand("saw.showOutput"));
      return;
    }
    this.letInChannel.letIn(this.sawBinary, folder);
  }

  /** Records saw writes for each check, wherever the command ran. */
  private watchStatus(): void {
    if (this.statusWatcher || !this.statusDir) {
      return;
    }
    try {
      mkdirSync(this.statusDir, { recursive: true });
      this.statusWatcher = watch(this.statusDir, () => this.readNotices(this.statusDir));
    } catch (error) {
      this.log.warn(`saw could not watch its checks of incoming updates: ${String(error)}`);
    }
    this.readNotices(this.statusDir);
  }

  private readNotices(dir: string): void {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) {
        continue;
      }
      try {
        const notice = readNotice(readFileSync(nodePath.join(dir, name), "utf8"));
        if (notice) {
          this.applyNotice(notice);
        }
      } catch {
        // A notice being written. The next change reads it.
      }
    }
  }

  private applyNotice(notice: GovernNotice): void {
    const repo = nodePath.resolve(notice.repo);
    const folder = (vscode.workspace.workspaceFolders ?? []).find((item) => nodePath.resolve(item.uri.fsPath) === repo);
    const mark = `${notice.at}:${notice.phase}:${notice.step ?? ""}:${notice.details ? "details" : ""}`;
    if (!folder || this.seen.get(repo) === mark) {
      return;
    }
    this.seen.set(repo, mark);
    if (notice.phase === "checking") {
      this.checkingSince.set(repo, notice.at);
      this.model.setChecking(folder, notice.step);
      return;
    }
    this.checkingSince.delete(repo);
    this.model.clearChecking(folder);
    if (notice.phase === "applied") {
      this.model.setHeld(folder, undefined);
      if (notice.verdict && !mayRelease(notice.verdict)) {
        this.model.setUnheld(folder, true, "let-in");
        this.alerts.letIn(folder.name);
      } else {
        const engine = this.model.engine;
        const checkedBy = engine?.kind === "ready" && engine.behind ? behindVersion(engine.version, engine.behind) : undefined;
        this.alerts.applied(folder.name, notice.verdict, checkedBy);
      }
    } else if (notice.phase === "held") {
      const verdict = notice.verdict ?? "incomplete";
      this.model.setHeld(folder, { verdict, reasons: notice.reasons, released: false, at: notice.at, ...(notice.details ? { details: notice.details } : {}) });
      if (this.heldShown.get(repo) === notice.at) {
        return;
      }
      this.heldShown.set(repo, notice.at);
      this.alerts.held(folder, verdict, notice.details?.letIn ? () => this.letIn(folder) : undefined);
    } else if (notice.reasons.length) {
      this.log.info(`${folder.name}: ${notice.reasons.join(" ")}`);
    }
    this.controller.request(folder, { immediate: true });
  }

  /** True once the git file's text differs from the copy this window already saw. */
  private gitMoved(file: string): boolean {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      text = "";
    }
    const previous = this.gitMarks.get(file);
    this.gitMarks.set(file, text);
    return previous !== undefined && previous !== text;
  }

  dispose(): void {
    this.statusWatcher?.close();
    this.questions.dispose();
  }
}
