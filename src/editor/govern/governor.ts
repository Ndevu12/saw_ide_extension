import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import * as nodePath from "node:path";

import * as vscode from "vscode";

import { FEATURES, supports } from "../../core/capabilities";
import type { GovernConfig } from "../../core/govern/contract";
import type { Tool } from "../../core/govern/command";
import { folderKey, posixWrapper, windowsWrapper } from "../../core/govern/plan";
import type { FolderVerdict } from "../../core/scan/verdict";
import { defaultIsExecutableFile } from "../../core/install/locate";
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

interface Notice {
  repo: string;
  verdict: FolderVerdict;
  reasons: string[];
  released: boolean;
  at: number;
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
  private readonly seen = new Map<string, number>();
  private watcher: FSWatcher | undefined;
  private active = false;
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
      }
      return;
    }
    if (this.starting) {
      this.pending = true;
      return;
    }
    this.starting = true;
    void this.enable(ready.binary).finally(() => {
      this.starting = false;
      if (this.pending) {
        this.pending = false;
        this.refresh();
      }
    });
  }

  private async enable(saw: string): Promise<void> {
    const realGit = await this.realBinary("git");
    const realGh = await this.realBinary("gh");
    const signature = JSON.stringify({ saw, realGit, realGh, timeoutMs: this.settings().timeoutMs, folders: this.folders() });
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
    };
    this.writeConfig(config);
    this.installer.exposeToTerminals([this.shimDir]);
    this.signature = signature;
    this.active = true;
    this.watchResults();
    await this.pointGit(nodePath.join(this.shimDir, process.platform === "win32" ? "git.cmd" : "git"));
    this.log.info("Incoming git updates in open folders wait for saw.");
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
    if (saved && defaultIsExecutableFile(saved) && !this.isShim(saved)) {
      return saved;
    }
    if (name === "git") {
      const resolved = await gitBinary();
      if (resolved && !this.isShim(resolved)) {
        return resolved;
      }
    }
    return lookUp(name, this.shimDir) ?? "";
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
    const relative = nodePath.relative(this.shimDir, file);
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

  private watchResults(): void {
    if (this.watcher) {
      return;
    }
    try {
      this.watcher = watch(this.resultDir, () => this.readResults());
    } catch (error) {
      this.log.warn(`saw could not watch held updates: ${String(error)}`);
    }
    this.readResults();
  }

  private readResults(): void {
    let names: string[];
    try {
      names = readdirSync(this.resultDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) {
        continue;
      }
      try {
        const notice = JSON.parse(readFileSync(nodePath.join(this.resultDir, name), "utf8")) as Notice;
        this.applyNotice(notice);
      } catch {
        // A notice being written. The next change reads it.
      }
    }
  }

  private applyNotice(notice: Notice): void {
    const folder = (vscode.workspace.workspaceFolders ?? []).find((item) => item.uri.fsPath === notice.repo);
    if (!folder || typeof notice.at !== "number" || this.seen.get(notice.repo) === notice.at) {
      return;
    }
    this.seen.set(notice.repo, notice.at);
    rmSync(nodePath.join(this.markerDir, folderKey(notice.repo)), { force: true });
    if (notice.released) {
      this.model.setHeld(folder, undefined);
    } else {
      this.model.setHeld(folder, { verdict: notice.verdict, reasons: notice.reasons ?? [], released: false, at: notice.at });
      this.alerts.held(folder.name, notice.verdict);
    }
    this.controller.request(folder, { immediate: true });
  }

  dispose(): void {
    this.watcher?.close();
  }
}

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

function lookUp(name: string, skipDir: string): string | undefined {
  const names = process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const dir of (process.env["PATH"] ?? "").split(nodePath.delimiter)) {
    if (!dir || nodePath.resolve(dir) === nodePath.resolve(skipDir)) {
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
