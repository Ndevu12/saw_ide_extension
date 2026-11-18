import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import * as nodePath from "node:path";

import * as vscode from "vscode";

import { FEATURES, supports } from "../../core/capabilities";
import { configOutsideFolders } from "../../core/controls";
import { governFeatures, offersGovernRestore, offersGovernVerdict, openAdmission, readGoverned, readNotice, readRestore, restoreArgs, sameCheck, shouldRestore, unheldAfter, verdictArgs, type GovernConfig, type GovernFeatures, type Governed, type GovernedReading, type GovernNotice } from "../../core/govern/contract";
import { quietGit, type Tool } from "../../core/govern/command";
import { answerFileName, ASK_EDITOR_MS, askFileName, commandText, readUpdateAsk, type Decision, type UpdateAsk } from "../../core/govern/decision";
import { heldFileName, LET_IN_UPDATE, readHeldRecord } from "../../core/govern/held";
import { folderKey, governStatusDir, posixWrapper, standinBeside, systemGovernBin, windowsWrapper } from "../../core/govern/plan";
import { diskFiles, findRealProgram, isRealProgram, isStandin } from "../../core/govern/realProgram";
import { behindVersion } from "../../core/install/upgrade";
import { defaultIsExecutableFile } from "../../core/install/locate";
import { runProgram } from "../../core/run";
import type { FolderVerdict } from "../../core/scan/verdict";
import type { Controller } from "../scan/controller";
import type { Installer } from "../install/installer";
import type { HeldDetails, Model } from "../model";
import type { Settings } from "../settings";
import { VERDICT_LABEL } from "../present";
import type { Alerts } from "../view/alerts";

interface GitApi {
  git?: { path: string };
}
interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitApi;
}

/**
 * When saw can check an update before it lands, stand in front of git and gh for open folders.
 * The stand-in asks saw. This class only writes the stand-in's configuration and shows the result.
 */
export class Governor implements vscode.Disposable {
  private readonly root: string;
  private readonly shimDir: string;
  private readonly configPath: string;
  private readonly holdingRoot: string;
  private readonly markerDir: string;
  private readonly resultDir: string;
  private readonly askDir: string;
  /** Questions from the stand-in this window is showing, so a second change to the file does not show one again. */
  private readonly asking = new Set<string>();
  private askWatcher: FSWatcher | undefined;
  private readonly seen = new Map<string, string>();
  /** First time a phase was shown for a folder, so the other writer of that check is skipped. */
  private readonly shownAt = new Map<string, number>();
  private readonly gitMarks = new Map<string, string>();
  /** Folders already asked, once per saw binary, for this window. */
  private readonly askedOpen = new Set<string>();
  /** A folder whose open verdict is running, so its restore does not start a second one. */
  private readonly admitting = new Set<string>();
  private watcher: FSWatcher | undefined;
  private statusWatcher: FSWatcher | undefined;
  private sawBinary = "";
  private verdictReady = false;
  private restoreReady = false;
  private statusDir = "";
  private active = false;
  /** Set when `saw govern install` already covers terminals, so this window does not add a second stand-in. */
  private systemBin: string | undefined;
  private starting = false;
  private pending = false;
  private signature = "";

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly model: Model,
    private readonly controller: Controller,
    private readonly installer: Installer,
    private readonly alerts: Alerts,
    private readonly settings: () => Settings,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.root = nodePath.join(context.globalStorageUri.fsPath, "govern");
    this.shimDir = nodePath.join(this.root, "bin");
    this.configPath = nodePath.join(this.root, "config.json");
    this.holdingRoot = nodePath.join(this.root, "holding");
    this.markerDir = nodePath.join(this.root, "markers");
    this.resultDir = nodePath.join(this.root, "results");
    this.askDir = nodePath.join(this.root, "asks");
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
   * True while saw is copying a checked update into this folder, so a watcher does not scan a
   * half-written tree. The scan runs when that copy finishes.
   */
  /**
   * A `.git/HEAD` or `ORIG_HEAD` change this window's stand-in did not make. The folder already
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

  private applyUnheld(folder: vscode.WorkspaceFolder, answer: Governed | undefined, from: "command" | "open" = "command"): void {
    const decision = unheldAfter(answer, this.systemBin !== undefined);
    if (decision === "clear") {
      this.model.setUnheld(folder, false);
      return;
    }
    if (decision === "mark") {
      this.model.setUnheld(folder, true, from);
      if (from === "open") {
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

  claim(uri: vscode.Uri): boolean {
    if (!this.active) {
      return false;
    }
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder || folder.uri.scheme !== "file") {
      return false;
    }
    return this.markerFresh(folder.uri.fsPath);
  }

  private refresh(): void {
    const engine = this.model.engine;
    const ready = engine?.kind === "ready" ? engine : undefined;
    const wanted = this.settings().governUpdates && !!ready && supports(ready.capabilities, FEATURES.govern, "govern");
    if (!wanted || !ready) {
      if (this.signature !== "") {
        this.signature = "";
        this.active = false;
        this.writeEnabled(false);
        this.installer.exposeToTerminals();
        this.context.environmentVariableCollection.delete("SAW_GOVERN_SYSTEM");
        void this.restoreGit();
      }
      return;
    }
    if (this.starting) {
      this.pending = true;
      return;
    }
    this.starting = true;
    void this.enable(ready.binary, governFeatures(ready.capabilities)).finally(() => {
      this.starting = false;
      if (this.pending) {
        this.pending = false;
        this.refresh();
      }
    });
  }

  private async enable(saw: string, features: GovernFeatures): Promise<void> {
    const systemBin = this.systemPlacement();
    this.systemBin = systemBin;
    const realGit = await this.realBinary("git");
    const realGh = await this.realBinary("gh");
    const standin = standinBeside(saw, defaultIsExecutableFile);
    this.sawBinary = saw;
    this.statusDir = governStatusDir(process.env["XDG_STATE_HOME"], homedir());
    const help = await this.governHelp(saw);
    this.verdictReady = offersGovernVerdict(help);
    this.restoreReady = offersGovernRestore(help);
    if (!realGit) {
      this.log.warn("saw cannot stand in front of git, because git was not found.");
      this.active = false;
      return;
    }
    const quietHooks = await this.quietHooks(realGit);
    const signature = JSON.stringify({ saw, realGit, realGh, ...features, standin, systemBin, verdict: this.verdictReady, restore: this.restoreReady, quietHooks, timeoutMs: this.settings().timeoutMs, folders: this.folders() });
    if (signature === this.signature && this.active) {
      return;
    }
    mkdirSync(this.shimDir, { recursive: true });
    mkdirSync(this.holdingRoot, { recursive: true });
    mkdirSync(this.markerDir, { recursive: true });
    mkdirSync(this.resultDir, { recursive: true });
    mkdirSync(this.askDir, { recursive: true });
    const shim = this.context.asAbsolutePath("dist/govern-shim.js");
    this.writeWrapper("git", realGit, shim);
    if (realGh) {
      this.writeWrapper("gh", realGh, shim);
    }
    const config: GovernConfig = {
      enabled: true,
      saw,
      realGit,
      realGh,
      timeoutMs: this.settings().timeoutMs,
      folders: this.folders(),
      holdingRoot: this.holdingRoot,
      markerDir: this.markerDir,
      resultDir: this.resultDir,
      progress: features.progress,
      ...(features.deadline ? { deadline: true } : {}),
      ...(standin ? { standin } : {}),
      quietHooks,
      standinDirs: this.standinDirs(),
      askDir: this.askDir,
      ...(features.decides ? { decides: true } : {}),
    };
    this.writeConfig(config);
    this.coverTerminals(systemBin);
    this.signature = signature;
    this.active = true;
    this.watchResults();
    this.watchAsks();
    if (this.verdictReady) {
      this.watchStatus();
      await this.askOpenFolders();
    }
    await this.pointGit(nodePath.join(this.shimDir, process.platform === "win32" ? "git.cmd" : "git"));
    // On Windows the Git view cannot be pointed at a batch file, so only the terminal waits for saw.
    const gitView = process.platform === "win32" ? " On Windows, a pull from the Git view is not held." : "";
    this.log.info(systemBin
      ? `Terminals already use saw's stand-in.${gitView || " The Git view still checks an incoming update."}`
      : `Incoming git updates in open folders wait for saw.${gitView}`);
  }

  /**
   * Ask whether saw let each open folder in, once per saw for this window. A restore finishes
   * before Git is pointed at the stand-in, because that step can reload the window.
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
      const decision = openAdmission(await this.verdictOf(folder), this.restoreReady);
      const restored = decision === "restore" ? await this.restoreOpen(folder) : false;
      if (shown && this.model.get(folder).checkAbout === "admission") {
        this.model.clearChecking(folder);
      }
      if (decision === "clear" || (decision === "restore" && restored)) {
        this.applyUnheld(folder, "let-in", "open");
      } else if (decision === "mark" || decision === "restore") {
        this.applyUnheld(folder, "not-let-in", "open");
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

  /** Put the folder back while a marker keeps a scan off the half-written tree, then record HEAD. */
  private async restoreOpen(folder: vscode.WorkspaceFolder): Promise<boolean> {
    const repo = folder.uri.fsPath;
    this.holdMarker(repo);
    try {
      return await this.putBack(folder);
    } finally {
      this.seedGit(repo);
      this.releaseMarker(repo);
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

  private holdMarker(folder: string): void {
    mkdirSync(this.markerDir, { recursive: true });
    writeFileSync(nodePath.join(this.markerDir, folderKey(folder)), String(Date.now()));
  }

  private releaseMarker(folder: string): void {
    rmSync(nodePath.join(this.markerDir, folderKey(folder)), { force: true });
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

  /**
   * Hooks git may run for an open folder. The operator's own global hooks, when they sit outside
   * every open folder. Otherwise an empty directory, so the folder's hooks and hooksPath do not run.
   */
  private async quietHooks(realGit: string): Promise<string> {
    const empty = nodePath.join(this.root, "empty-hooks");
    mkdirSync(empty, { recursive: true });
    const run = await runProgram(realGit, quietGit(["config", "--global", "--get", "core.hooksPath"], empty), {
      timeoutMs: 10_000,
      maxOutputBytes: 8 * 1024,
    });
    const value = run.stdout.trim();
    if (run.exitCode !== 0 || run.timedOut || run.spawnError || !nodePath.isAbsolute(value)) {
      return empty;
    }
    return configOutsideFolders(value, this.folders()) || empty;
  }

  /** `saw govern install` wrote this directory. Absent when that step has not been run. */
  private systemPlacement(): string | undefined {
    const dir = systemGovernBin(process.env["XDG_CONFIG_HOME"], homedir());
    return defaultIsExecutableFile(nodePath.join(dir, "git")) ? dir : undefined;
  }

  /**
   * One stand-in in the integrated terminal. When saw already covers terminals, use that
   * directory and turn it on. Otherwise use this window's own.
   */
  private coverTerminals(systemBin: string | undefined): void {
    const env = this.context.environmentVariableCollection;
    if (systemBin) {
      this.installer.exposeToTerminals([systemBin]);
      env.replace("SAW_GOVERN_SYSTEM", "1");
      return;
    }
    env.delete("SAW_GOVERN_SYSTEM");
    this.installer.exposeToTerminals([this.shimDir]);
  }

  private writeEnabled(enabled: boolean): void {
    if (!existsSync(this.configPath)) {
      return;
    }
    try {
      const config = JSON.parse(readFileSync(this.configPath, "utf8")) as GovernConfig;
      config.enabled = enabled;
      config.folders = this.folders();
      this.writeConfig(config);
    } catch {
      // The next enable rewrites it.
    }
  }

  private writeConfig(config: GovernConfig): void {
    mkdirSync(this.root, { recursive: true });
    writeFileSync(`${this.configPath}.tmp`, JSON.stringify(config));
    renameSync(`${this.configPath}.tmp`, this.configPath);
  }

  private writeWrapper(tool: Tool, real: string, shim: string): void {
    const windows = process.platform === "win32";
    const file = nodePath.join(this.shimDir, windows ? `${tool}.cmd` : tool);
    const body = windows
      ? windowsWrapper(process.execPath, shim, this.configPath, real, tool)
      : posixWrapper(process.execPath, shim, this.configPath, real, tool);
    writeFileSync(file, body, { mode: 0o755 });
  }

  private folders(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === "file").map((folder) => folder.uri.fsPath);
  }

  private async realBinary(name: "git" | "gh"): Promise<string> {
    const standins = this.standinDirs();
    const real = (file: string) => isRealProgram(file, standins, diskFiles);
    const saved = this.savedReal(name);
    if (real(saved)) {
      return saved;
    }
    const search = { pathVariable: process.env["PATH"], platform: process.platform, extraDirs: [nodePath.join(homedir(), ".local", "bin")] };
    if (name === "git") {
      const resolved = await gitBinary();
      // VS Code's git extension can report the bare name `git`, which PATH resolves to the stand-in.
      const found = resolved && !nodePath.isAbsolute(resolved) ? findRealProgram(resolved, search, standins, diskFiles) : resolved;
      if (found && real(found)) {
        return found;
      }
    }
    return findRealProgram(name, search, standins, diskFiles) ?? "";
  }

  /** The folders whose git and gh are stand-ins: this window's, and saw's own when it placed one. */
  private standinDirs(): string[] {
    return [this.shimDir, ...(this.systemBin ? [this.systemBin] : [])];
  }

  private savedReal(name: "git" | "gh"): string {
    try {
      const config = JSON.parse(readFileSync(this.configPath, "utf8")) as Partial<GovernConfig>;
      const value = name === "git" ? config.realGit : config.realGh;
      return typeof value === "string" ? value : "";
    } catch {
      return "";
    }
  }

  private isShim(file: string): boolean {
    return isStandin(file, [this.shimDir], diskFiles);
  }

  private async pointGit(shim: string): Promise<void> {
    if (process.platform === "win32") {
      return;
    }
    const git = vscode.workspace.getConfiguration("git");
    const current = git.get<string>("path") ?? "";
    if (current !== shim) {
      if (current && !this.isShim(current)) {
        await this.context.globalState.update("govern.previousGitPath", current);
      }
      await git.update("path", shim, vscode.ConfigurationTarget.Global);
    }
    const resolved = await gitBinary();
    if (resolved && !this.isShim(resolved) && !this.context.globalState.get<boolean>("govern.reloadAsked")) {
      await this.context.globalState.update("govern.reloadAsked", true);
      const choice = await vscode.window.showInformationMessage(
        "Reload the window so saw can check a pull or checkout before it changes this folder.",
        "Reload Window",
      );
      if (choice === "Reload Window") {
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
    }
  }

  /** A marker left behind by a stand-in that did not finish must not keep the folder from being scanned. */
  private markerFresh(folder: string): boolean {
    const file = nodePath.join(this.markerDir, folderKey(folder));
    if (!existsSync(file)) {
      return false;
    }
    let started: number;
    try {
      started = Number(readFileSync(file, "utf8"));
    } catch {
      started = Number.NaN;
    }
    if (Number.isFinite(started) && Date.now() - started <= this.settings().timeoutMs) {
      return true;
    }
    rmSync(file, { force: true });
    return false;
  }

  private async governHelp(saw: string): Promise<string> {
    const help = await runProgram(saw, ["govern", "-h"], { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
    return `${help.stdout}\n${help.stderr}`;
  }

  private watchResults(): void {
    if (this.watcher) {
      return;
    }
    try {
      this.watcher = watch(this.resultDir, () => this.readNotices(this.resultDir));
    } catch (error) {
      this.log.warn(`saw could not watch held updates: ${String(error)}`);
    }
    this.readNotices(this.resultDir);
  }

  /** Questions the stand-in leaves when no terminal can answer, as from the Git view: about an update saw could not check, or one it held. */
  private watchAsks(): void {
    if (this.askWatcher) {
      return;
    }
    try {
      this.askWatcher = watch(this.askDir, () => this.readAsks());
    } catch (error) {
      this.log.warn(`saw could not watch for questions about updates it could not check: ${String(error)}`);
    }
    this.readAsks();
  }

  private readAsks(): void {
    let names: string[];
    try {
      names = readdirSync(this.askDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".ask.json")) {
        continue;
      }
      let ask: UpdateAsk | undefined;
      try {
        ask = readUpdateAsk(readFileSync(nodePath.join(this.askDir, name), "utf8"));
      } catch {
        continue;
      }
      const repo = ask && nodePath.resolve(ask.repo);
      const folder = repo && (vscode.workspace.workspaceFolders ?? []).find((item) => nodePath.resolve(item.uri.fsPath) === repo);
      if (!ask || !folder || this.asking.has(ask.id) || Date.now() - ask.at > ASK_EDITOR_MS) {
        continue;
      }
      this.asking.add(ask.id);
      void this.askUpdate(ask, folder.name).finally(() => this.asking.delete(ask.id));
    }
  }

  private async askUpdate(ask: UpdateAsk, name: string): Promise<void> {
    const decision = ask.held ? await this.askLetIn(ask, ask.held, name) : await this.askRun(ask, name);
    const answer = nodePath.join(this.askDir, answerFileName(ask.id));
    try {
      // The first window to answer decides. The stand-in removes the question once it reads one.
      writeFileSync(answer, decision, { flag: "wx" });
    } catch {
      // Answered already.
    }
    if (!existsSync(nodePath.join(this.askDir, askFileName(ask.id)))) {
      // The stand-in stopped waiting, and left the folder unchanged.
      rmSync(answer, { force: true });
      return;
    }
    const what = ask.held ? `saw held \`${commandText(ask.tool, ask.args)}\` (${ask.held})` : `saw could not check \`${commandText(ask.tool, ask.args)}\``;
    this.log.info(`${name}: ${what}; ${decision === "run-as-typed" ? (ask.held ? "let in" : "run as typed") : "left unchanged"}.`);
  }

  private async askRun(ask: UpdateAsk, name: string): Promise<Decision> {
    const run = "Run As Typed";
    const picked = await vscode.window.showWarningMessage(
      `saw can't check this update to ${name}: ${ask.reason}.`,
      { modal: true, detail: `Run \`${commandText(ask.tool, ask.args)}\` as typed? saw scans the folder straight after. Otherwise the folder stays as it is.` },
      run,
      "Leave Unchanged",
    );
    return picked === run ? "run-as-typed" : "leave-unchanged";
  }

  /** The update's details open first, so the operator reads what was found before choosing. */
  private async askLetIn(ask: UpdateAsk, verdict: FolderVerdict, name: string): Promise<Decision> {
    const folder = this.folderOf(ask.repo);
    if (folder) {
      await vscode.commands.executeCommand("saw.openReport", { kind: "held", state: { folder } });
    }
    const letIn = "Let In Anyway";
    const infected = verdict === "infected";
    const picked = await (infected ? vscode.window.showErrorMessage : vscode.window.showWarningMessage)(
      `saw held this update to ${name} (${VERDICT_LABEL[verdict]}): ${ask.reason}`,
      {
        modal: true,
        detail: infected
          ? `What it would bring is infected, so it is safest to leave it. To work on it anyway, for example to fix it, let it in: you are asked to type the folder's name. saw scans the folder straight after.`
          : `The details tab shows what saw found. Let \`${commandText(ask.tool, ask.args)}\` in anyway? saw scans the folder straight after. Otherwise the folder stays as it is.`,
      },
      letIn,
      "Leave Unchanged",
    );
    if (picked !== letIn) {
      return "leave-unchanged";
    }
    if (!infected) {
      return "run-as-typed";
    }
    const expected = nodePath.basename(ask.repo);
    const typed = await vscode.window.showInputBox({
      title: `Let an infected update into ${name}`,
      prompt: `Type ${expected} to let it in. Nothing from it runs, but the files land in the folder.`,
      placeHolder: expected,
      ignoreFocusOut: true,
      validateInput: (value) => value === "" || value === expected ? undefined : `Type ${expected} exactly, or press Escape to leave the folder unchanged.`,
    });
    return typed === expected ? "run-as-typed" : "leave-unchanged";
  }

  private folderOf(repo: string): vscode.WorkspaceFolder | undefined {
    const resolved = nodePath.resolve(repo);
    return (vscode.workspace.workspaceFolders ?? []).find((item) => nodePath.resolve(item.uri.fsPath) === resolved);
  }

  /** What the stand-in kept about the update it held for this notice, when it kept it. */
  private heldDetails(notice: GovernNotice): HeldDetails | undefined {
    let text: string;
    try {
      text = readFileSync(nodePath.join(this.resultDir, heldFileName(folderKey(notice.repo))), "utf8");
    } catch {
      return undefined;
    }
    const record = readHeldRecord(text);
    if (!record || nodePath.resolve(record.repo) !== nodePath.resolve(notice.repo) || Math.abs(notice.at - record.at) > HELD_RECORD_MS) {
      return undefined;
    }
    return { command: commandText(record.tool, record.args), nextSteps: record.nextSteps, scan: record.scan };
  }

  /** Records saw writes for a check this window did not start. They outlive the holding directory. */
  private watchStatus(): void {
    if (this.statusWatcher || !this.statusDir) {
      return;
    }
    try {
      mkdirSync(this.statusDir, { recursive: true });
      this.statusWatcher = watch(this.statusDir, () => this.readNotices(this.statusDir));
    } catch (error) {
      this.log.warn(`saw could not watch a check it did not start: ${String(error)}`);
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
    const mark = `${notice.at}:${notice.phase}:${notice.step ?? ""}`;
    const key = `${repo}:${notice.phase}`;
    const shown = this.shownAt.get(key);
    if (sameCheck(shown, notice.at, SAME_CHECK_MS) && shown !== notice.at) {
      return;
    }
    if (!folder || this.seen.get(repo) === mark) {
      return;
    }
    this.seen.set(repo, mark);
    if (shown === undefined) {
      this.shownAt.set(key, notice.at);
    }
    if (notice.phase === "checking") {
      this.model.setChecking(folder, notice.step);
      return;
    }
    this.model.clearChecking(folder);
    if (notice.phase === "finished") {
      if (notice.reasons.length) {
        // A command saw could not hold, such as a clone, or one let in as typed, changed the folder: say so, and scan it now.
        const letIn = notice.reasons[0] === LET_IN_UPDATE;
        this.model.setHeld(folder, undefined);
        this.model.setUnheld(folder, true, letIn ? "let-in" : "command");
        if (letIn) {
          this.alerts.letIn(folder.name);
        } else {
          this.alerts.unheld(folder.name);
        }
      }
      this.controller.request(folder, { immediate: true });
      return;
    }
    rmSync(nodePath.join(this.markerDir, folderKey(folder.uri.fsPath)), { force: true });
    if (notice.phase === "applied") {
      this.model.setHeld(folder, undefined);
      const engine = this.model.engine;
      const checkedBy = engine?.kind === "ready" && engine.behind ? behindVersion(engine.version, engine.behind) : undefined;
      if (notice.verdict) {
        this.alerts.applied(folder.name, notice.verdict, checkedBy);
      } else {
        this.alerts.applied(folder.name, undefined, checkedBy);
      }
    } else {
      const details = this.heldDetails(notice);
      this.model.setHeld(folder, { verdict: notice.verdict ?? "incomplete", reasons: notice.reasons, released: false, at: notice.at, ...(details ? { details } : {}) });
      this.alerts.held(folder, notice.verdict ?? "incomplete");
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
    this.watcher?.close();
    this.statusWatcher?.close();
    this.askWatcher?.close();
    this.writeEnabled(false);
  }

  /** Put Git's path back when this window stops standing in front of it. */
  private async restoreGit(): Promise<void> {
    if (process.platform === "win32") {
      return;
    }
    const git = vscode.workspace.getConfiguration("git");
    const current = git.get<string>("path") ?? "";
    if (!current || !this.isShim(current)) {
      return;
    }
    const previous = this.context.globalState.get<string>("govern.previousGitPath") ?? "";
    await git.update("path", previous, vscode.ConfigurationTarget.Global);
  }
}

/** Saw and this window write one check a few seconds apart. A later check is a new one. */
const SAME_CHECK_MS = 5_000;

/** The stand-in keeps a held update's details just before its notice; an older record is another update's. */
const HELD_RECORD_MS = 60_000;

async function gitBinary(): Promise<string | undefined> {
  const extension = vscode.extensions.getExtension<GitExtension>("vscode.git");
  if (!extension) {
    return undefined;
  }
  try {
    const exports = extension.isActive ? extension.exports : await extension.activate();
    return exports.enabled ? exports.getAPI(1).git?.path : undefined;
  } catch {
    return undefined;
  }
}

