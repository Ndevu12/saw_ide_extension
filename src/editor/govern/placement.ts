import { mkdirSync, readdirSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import * as nodePath from "node:path";

import * as vscode from "vscode";

import { realOnPath, STANDIN_TOOLS, systemGovernBin, type ProgramFiles } from "../../core/govern/places";
import { QUESTIONS_ENV } from "../../core/govern/questions";
import { copyName, realOnWindowsPath, sameWindowsPath, windowsStandin } from "../../core/govern/windowsPlaces";
import { defaultIsExecutableFile, realPath } from "../../core/install/locate";
import type { Installer } from "../install/installer";
import { clearCopies, diskCopies, placeCopies, type NotRemoved } from "./standinCopies";

interface GitApi {
  git?: { path: string };
}
interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitApi;
}

const TURNED_ON = "SAW_GOVERN_SYSTEM";
const SAW = "SAW_BIN";
const PREVIOUS_GIT_PATH = "govern.previousGitPath";
const RELOAD_ASKED = "govern.reloadAsked";
const KEPT = new Set(["bin", "questions"]);

const disk: ProgramFiles = { isExecutableFile: defaultIsExecutableFile, realpath: realPath };

function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function changedAt(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** Puts saw's own git and gh check in front of git and gh, for this editor's terminals and Git view. */
export class Placement {
  private readonly root: string;
  private readonly bin: string;
  private readonly gitLink: string;
  private readonly hostBefore: Record<string, string | undefined>;
  private state: "placed" | "removed" | undefined;
  private signature = "";
  private covered = false;
  private gitViewPending: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly installer: Installer,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.root = nodePath.join(context.globalStorageUri.fsPath, "govern");
    this.bin = nodePath.join(this.root, "bin");
    this.gitLink = nodePath.join(this.bin, process.platform === "win32" ? copyName("git") : "git");
    this.hostBefore = { [TURNED_ON]: process.env[TURNED_ON], [SAW]: process.env[SAW], [QUESTIONS_ENV]: process.env[QUESTIONS_ENV] };
  }

  /**
   * Whether saw checks git commands in this editor's terminals. `questions` is the folder where saw
   * asks this editor about git it runs with no terminal. The Git view follows with `coverGitView`.
   */
  async place(saw: string, gitStandin: string | undefined, questions: string | undefined): Promise<boolean> {
    const onWindows = process.platform === "win32";
    const systemBin = this.systemPlacement();
    const standin = onWindows ? windowsStandin(gitStandin, disk) : gitStandin;
    const signature = JSON.stringify({ saw, standin, built: standin ? changedAt(standin) : 0, questions, systemBin, path: process.env["PATH"] });
    if (this.state === "placed" && signature === this.signature) {
      return this.covered;
    }
    this.state = "placed";
    this.signature = signature;
    this.gitViewPending = undefined;
    this.clearOldFiles();
    const git = standin ? (onWindows ? this.copy(standin) : this.link(standin)) : undefined;
    this.coverTerminals(saw, git ? this.bin : undefined, systemBin);
    this.covered = git !== undefined || systemBin !== undefined;
    if (!git) {
      this.log.warn(standin
        ? "saw cannot check incoming git updates, because git was not found."
        : `saw cannot check incoming git updates before they change a folder: ${saw} does not include that check.`);
      this.restoreHost();
      await this.restoreGit();
      if (onWindows) {
        this.warnNotRemoved(clearCopies(this.bin, diskCopies));
      } else {
        rmSync(this.bin, { recursive: true, force: true });
      }
      return this.covered;
    }
    this.coverHost(saw, questions);
    this.gitViewPending = git;
    this.log.info("Incoming git updates in open folders wait for saw, in terminals and the Git view.");
    return this.covered;
  }

  /** Point the Git view at saw's check. This can ask to reload the window. */
  async coverGitView(): Promise<void> {
    const git = this.gitViewPending;
    this.gitViewPending = undefined;
    if (git) {
      await this.pointGit(git);
    }
  }

  async remove(): Promise<void> {
    if (this.state === "removed") {
      return;
    }
    this.state = "removed";
    this.signature = "";
    this.covered = false;
    this.gitViewPending = undefined;
    this.coverTerminals("", undefined, undefined);
    this.restoreHost();
    await this.restoreGit();
  }

  private link(standin: string): string | undefined {
    mkdirSync(this.bin, { recursive: true });
    for (const name of list(this.bin)) {
      if (!(STANDIN_TOOLS as readonly string[]).includes(name)) {
        rmSync(nodePath.join(this.bin, name), { recursive: true, force: true });
      }
    }
    for (const tool of STANDIN_TOOLS) {
      const link = nodePath.join(this.bin, tool);
      if (!realOnPath(tool, process.env["PATH"], standin, disk)) {
        rmSync(link, { force: true });
        continue;
      }
      const temporary = `${link}.${process.pid}.tmp`;
      rmSync(temporary, { force: true });
      symlinkSync(standin, temporary);
      renameSync(temporary, link);
    }
    return disk.isExecutableFile(this.gitLink) ? this.gitLink : undefined;
  }

  private copy(standin: string): string | undefined {
    const own = { standin, bin: this.bin };
    const tools = STANDIN_TOOLS.filter((tool) => realOnWindowsPath(tool, process.env["PATH"], process.env["PATHEXT"], own, disk));
    const copied = placeCopies(standin, this.bin, tools, diskCopies);
    this.warnNotRemoved(copied.notRemoved);
    return copied.git;
  }

  private warnNotRemoved(notRemoved: readonly NotRemoved[]): void {
    for (const { file, reason } of notRemoved) {
      this.log.warn(`saw could not remove ${file} yet, and tries again later: ${reason}`);
    }
  }

  private clearOldFiles(): void {
    for (const name of list(this.root)) {
      if (!KEPT.has(name)) {
        rmSync(nodePath.join(this.root, name), { recursive: true, force: true });
      }
    }
  }

  /** `saw govern install` wrote this directory. Absent when that step has not been run. */
  private systemPlacement(): string | undefined {
    const dir = systemGovernBin(process.env["XDG_CONFIG_HOME"], homedir());
    return defaultIsExecutableFile(nodePath.join(dir, "git")) ? dir : undefined;
  }

  /** When saw already covers terminals, use that directory. Otherwise use this editor's own. */
  private coverTerminals(saw: string, own: string | undefined, systemBin: string | undefined): void {
    const env = this.context.environmentVariableCollection;
    const lead = systemBin ?? own;
    if (!lead) {
      this.installer.exposeToTerminals();
      env.delete(TURNED_ON);
      env.delete(SAW);
      return;
    }
    this.installer.exposeToTerminals([lead]);
    env.replace(TURNED_ON, "1");
    if (systemBin) {
      env.delete(SAW);
    } else {
      env.replace(SAW, saw);
    }
  }

  private coverHost(saw: string, questions: string | undefined): void {
    this.restoreHost();
    process.env[TURNED_ON] = "1";
    process.env[SAW] = saw;
    if (questions) {
      process.env[QUESTIONS_ENV] = questions;
    }
  }

  private restoreHost(): void {
    for (const [name, value] of Object.entries(this.hostBefore)) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        process.env[name] = value;
      }
    }
  }

  private isOurs(file: string): boolean {
    return process.platform === "win32" ? sameWindowsPath(file, this.gitLink) : nodePath.resolve(file) === this.gitLink;
  }

  private async pointGit(git: string): Promise<void> {
    const config = vscode.workspace.getConfiguration("git");
    const current = config.get<string>("path") ?? "";
    if (current !== git) {
      if (current && !this.isOurs(current)) {
        await this.context.globalState.update(PREVIOUS_GIT_PATH, current);
      }
      await config.update("path", git, vscode.ConfigurationTarget.Global);
    }
    const resolved = await gitBinary();
    if (resolved && !this.isOurs(resolved) && !this.context.globalState.get<boolean>(RELOAD_ASKED)) {
      await this.context.globalState.update(RELOAD_ASKED, true);
      const choice = await vscode.window.showInformationMessage(
        "Reload the window so saw can check a pull or checkout before it changes this folder.",
        "Reload Window",
      );
      if (choice === "Reload Window") {
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
    }
  }

  private async restoreGit(): Promise<void> {
    const config = vscode.workspace.getConfiguration("git");
    const current = config.get<string>("path") ?? "";
    if (!current || !this.isOurs(current)) {
      return;
    }
    const previous = this.context.globalState.get<string>(PREVIOUS_GIT_PATH) ?? "";
    await config.update("path", previous || undefined, vscode.ConfigurationTarget.Global);
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
