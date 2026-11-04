import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import * as nodePath from "node:path";

import * as vscode from "vscode";

import { FEATURES, supports } from "../../core/capabilities";
import { offersGovernVerdict, readNotice, readVerdict, sameCheck, unheldAfter, verdictArgs, type GovernConfig, type Governed, type GovernNotice } from "../../core/govern/contract";
import type { Tool } from "../../core/govern/command";
import { folderKey, governStatusDir, posixWrapper, standinBeside, systemGovernBin, windowsWrapper } from "../../core/govern/plan";
import { defaultIsExecutableFile } from "../../core/install/locate";
import { runProgram } from "../../core/run";
import type { Controller } from "../scan/controller";
import type { Installer } from "../install/installer";
import type { Model } from "../model";
import type { Settings } from "../settings";
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
  private readonly seen = new Map<string, string>();
  /** First time a phase was shown for a folder, so the other writer of that check is skipped. */
  private readonly shownAt = new Map<string, number>();
  private readonly gitMarks = new Map<string, string>();
  private watcher: FSWatcher | undefined;
  private statusWatcher: FSWatcher | undefined;
  private sawBinary = "";
  private verdictReady = false;
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
    context.subscriptions.push(
      model.onDidChange(() => this.refresh()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
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
    if (!folder || !this.gitMoved(uri.fsPath)) {
      return;
    }
    if (!this.verdictReady || !this.sawBinary) {
      this.applyUnheld(folder, undefined);
      return;
    }
    void this.askVerdict(folder);
  }

  private applyUnheld(folder: vscode.WorkspaceFolder, answer: Governed | undefined): void {
    const decision = unheldAfter(answer, this.systemBin !== undefined);
    if (decision === "clear") {
      this.model.setUnheld(folder, false);
      return;
    }
    if (decision === "mark") {
      this.model.setUnheld(folder, true);
      this.alerts.unheld(folder.name);
    }
  }

  private async askVerdict(folder: vscode.WorkspaceFolder): Promise<void> {
    const run = await runProgram(this.sawBinary, verdictArgs(folder.uri.fsPath), {
      timeoutMs: this.settings().timeoutMs,
      maxOutputBytes: 64 * 1024,
    });
    const answer = run.timedOut || run.spawnError || run.cancelled ? "could-not-answer" : readVerdict(run.stdout);
    this.applyUnheld(folder, answer);
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
    void this.enable(ready.binary, ready.capabilities.features.has("govern.progress.jsonl")).finally(() => {
      this.starting = false;
      if (this.pending) {
        this.pending = false;
        this.refresh();
      }
    });
  }

  private async enable(saw: string, progress: boolean): Promise<void> {
    const systemBin = this.systemPlacement();
    this.systemBin = systemBin;
    const realGit = await this.realBinary("git");
    const realGh = await this.realBinary("gh");
    const standin = standinBeside(saw, defaultIsExecutableFile);
    this.sawBinary = saw;
    this.statusDir = governStatusDir(process.env["XDG_STATE_HOME"], homedir());
    this.verdictReady = await this.probeVerdict(saw);
    const signature = JSON.stringify({ saw, realGit, realGh, progress, standin, systemBin, verdict: this.verdictReady, timeoutMs: this.settings().timeoutMs, folders: this.folders() });
    if (signature === this.signature && this.active) {
      return;
    }
    if (!realGit) {
      this.log.warn("saw cannot stand in front of git, because git was not found.");
      this.active = false;
      return;
    }
    mkdirSync(this.shimDir, { recursive: true });
    mkdirSync(this.holdingRoot, { recursive: true });
    mkdirSync(this.markerDir, { recursive: true });
    mkdirSync(this.resultDir, { recursive: true });
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
      progress,
      ...(standin ? { standin } : {}),
    };
    this.writeConfig(config);
    this.coverTerminals(systemBin);
    this.signature = signature;
    this.active = true;
    this.watchResults();
    if (this.verdictReady) {
      this.watchStatus();
    }
    await this.pointGit(nodePath.join(this.shimDir, process.platform === "win32" ? "git.cmd" : "git"));
    this.log.info(systemBin
      ? "Terminals already use saw's stand-in. The Git view still checks an incoming update."
      : "Incoming git updates in open folders wait for saw.");
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
    const saved = this.savedReal(name);
    if (saved && defaultIsExecutableFile(saved) && this.realProgram(saved)) {
      return saved;
    }
    if (name === "git") {
      const resolved = await gitBinary();
      if (resolved && this.realProgram(resolved)) {
        return resolved;
      }
    }
    return lookUp(name, [this.shimDir, this.systemBin ?? ""]) ?? "";
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
    return this.inDir(file, this.shimDir);
  }

  /** A path this window may call. A stand-in directory is not the real program. */
  private realProgram(file: string): boolean {
    return !this.isShim(file) && !this.inDir(file, this.systemBin);
  }

  private inDir(file: string, dir: string | undefined): boolean {
    if (!dir) {
      return false;
    }
    const relative = nodePath.relative(dir, file);
    return relative === "" || (!relative.startsWith("..") && !nodePath.isAbsolute(relative));
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

  private async probeVerdict(saw: string): Promise<boolean> {
    const help = await runProgram(saw, ["govern", "-h"], { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
    return offersGovernVerdict(`${help.stdout}\n${help.stderr}`);
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
      this.controller.request(folder, { immediate: true });
      return;
    }
    rmSync(nodePath.join(this.markerDir, folderKey(folder.uri.fsPath)), { force: true });
    if (notice.phase === "applied") {
      this.model.setHeld(folder, undefined);
      if (notice.verdict) {
        this.alerts.applied(folder.name, notice.verdict);
      } else {
        this.alerts.applied(folder.name);
      }
    } else {
      this.model.setHeld(folder, { verdict: notice.verdict ?? "incomplete", reasons: notice.reasons, released: false, at: notice.at });
      this.alerts.held(folder.name, notice.verdict ?? "incomplete");
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

function lookUp(name: string, skipDirs: readonly string[]): string | undefined {
  const skip = new Set(skipDirs.filter((dir) => dir).map((dir) => nodePath.resolve(dir)));
  const names = process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const dir of (process.env["PATH"] ?? "").split(nodePath.delimiter)) {
    if (!dir || skip.has(nodePath.resolve(dir))) {
      continue;
    }
    for (const file of names) {
      const candidate = nodePath.join(dir, file);
      if (defaultIsExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  // pipx's default folder is not always on the PATH the editor was started with.
  const local = nodePath.join(homedir(), ".local", "bin", name);
  return defaultIsExecutableFile(local) ? local : undefined;
}
