import * as vscode from "vscode";

import { AUTOMATIC_TASKS, configOutsideFolders, needsStrict, PROJECT_GIT, SAW_KEYS, STRICT_SETTINGS } from "../core/controls";
import type { Model } from "./model";

const MEMORY = "saw.strictPrevious";

interface Remembered {
  defined: boolean;
  value?: unknown;
}

/**
 * Drops project overrides of saw's controls and of `git.path`, and, while a folder is suspicious,
 * infected, unheld, or holding an update, writes the strict user value for the settings that
 * would otherwise let that folder act: untrusted files open in a new window, extension
 * recommendations stay quiet, and task detection stays off. The user value from before that
 * write is put back when nothing open still needs it.
 */
export class StrictMode implements vscode.Disposable {
  private readonly memory = new Map<string, Remembered>();
  private applying = false;
  private queued = false;
  private notedConfig = false;
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    context: vscode.ExtensionContext,
    private readonly model: Model,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.memory = remembered(context.globalState.get(MEMORY));
    this.subscriptions = [
      model.onDidChange(() => void this.sync()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.sync()),
      vscode.workspace.onDidChangeConfiguration(() => void this.sync()),
    ];
    this.context = context;
    void this.sync();
  }

  private readonly context: vscode.ExtensionContext;

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }

  private async sync(): Promise<void> {
    if (this.applying) {
      this.queued = true;
      return;
    }
    this.applying = true;
    try {
      do {
        this.queued = false;
        await this.pass();
      } while (this.queued);
    } catch (error) {
      this.log.warn(`saw could not keep its own settings: ${String(error)}`);
    } finally {
      this.applying = false;
    }
  }

  private async pass(): Promise<void> {
    this.noteConfig();
    const keys = [...SAW_KEYS.map((key) => `saw.${key}`), PROJECT_GIT, AUTOMATIC_TASKS, ...STRICT_SETTINGS.map((setting) => setting.key)];
    for (const key of keys) {
      await this.clearProject(key);
    }
    if (this.required()) {
      for (const setting of STRICT_SETTINGS) {
        await this.tighten(setting.key, setting.value);
      }
      return;
    }
    for (const setting of STRICT_SETTINGS) {
      await this.release(setting.key, setting.value);
    }
  }

  private noteConfig(): void {
    if (this.notedConfig) {
      return;
    }
    const configured = vscode.workspace.getConfiguration("saw").inspect<string>("configPath")?.globalValue ?? "";
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === "file").map((folder) => folder.uri.fsPath);
    if (configured.trim() && !configOutsideFolders(configured, folders)) {
      this.notedConfig = true;
      this.log.warn("saw.configPath is inside an open folder, so it is not used.");
    }
  }

  private required(): boolean {
    return needsStrict((vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === "file").map((folder) => {
      const state = this.model.get(folder);
      return { ...(state.last ? { verdict: state.last.verdict } : {}), unheld: state.unheld, held: state.held !== undefined };
    }));
  }

  /** Remove a workspace or folder value so it cannot sit above the user value. */
  private async clearProject(key: string): Promise<void> {
    const workspace = vscode.workspace.getConfiguration().inspect(key);
    if (workspace?.workspaceValue !== undefined) {
      await vscode.workspace.getConfiguration().update(key, undefined, vscode.ConfigurationTarget.Workspace);
      this.log.info(`Removed the workspace value of ${key}.`);
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== "file") {
        continue;
      }
      const inspected = vscode.workspace.getConfiguration(undefined, folder.uri).inspect(key);
      if (inspected?.workspaceFolderValue !== undefined) {
        await vscode.workspace.getConfiguration(undefined, folder.uri).update(key, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
        this.log.info(`Removed ${folder.name}'s value of ${key}.`);
      }
    }
  }

  private async tighten(key: string, value: string | boolean): Promise<void> {
    const inspected = vscode.workspace.getConfiguration().inspect(key);
    if (!this.memory.has(key)) {
      const defined = inspected?.globalValue !== undefined;
      this.memory.set(key, defined ? { defined: true, value: inspected?.globalValue } : { defined: false });
      await this.context.globalState.update(MEMORY, Object.fromEntries(this.memory));
    }
    if (inspected?.globalValue !== value) {
      await vscode.workspace.getConfiguration().update(key, value, vscode.ConfigurationTarget.Global);
      this.log.info(`${key} is ${value} while a folder is not in the clear.`);
    }
  }

  private async release(key: string, value: string | boolean): Promise<void> {
    const saved = this.memory.get(key);
    if (!saved) {
      return;
    }
    this.memory.delete(key);
    await this.context.globalState.update(MEMORY, Object.fromEntries(this.memory));
    const current = vscode.workspace.getConfiguration().inspect(key)?.globalValue;
    if (current !== value) {
      return;
    }
    await vscode.workspace.getConfiguration().update(key, saved.defined ? saved.value : undefined, vscode.ConfigurationTarget.Global);
    this.log.info(`${key} is back to the value it had before.`);
  }
}

function remembered(stored: unknown): Map<string, Remembered> {
  const memory = new Map<string, Remembered>();
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return memory;
  }
  for (const [key, value] of Object.entries(stored)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const record = value as { defined?: unknown; value?: unknown };
    if (record.defined === true) {
      memory.set(key, { defined: true, value: record.value });
    } else if (record.defined === false) {
      memory.set(key, { defined: false });
    }
  }
  return memory;
}
