import * as vscode from "vscode";

import { AUTOMATIC_TASKS } from "../core/controls";
import {
  heldQuestion,
  isFolderOpenRun,
  openRunKey,
  openRunQuestion,
  settingSummary,
  shellHeldQuestion,
  shellQuestion,
  shellUsesFolder,
  terminalSettingQuestion,
} from "../core/openRun";

/** Workspace settings that choose the shell a terminal or a task starts. A project value is held until allowed. */
const TERMINAL_SETTINGS = [
  "terminal.integrated.defaultProfile.linux",
  "terminal.integrated.defaultProfile.osx",
  "terminal.integrated.defaultProfile.windows",
  "terminal.integrated.profiles.linux",
  "terminal.integrated.profiles.osx",
  "terminal.integrated.profiles.windows",
  "terminal.integrated.automationProfile.linux",
  "terminal.integrated.automationProfile.osx",
  "terminal.integrated.automationProfile.windows",
  "terminal.integrated.shellArgs.linux",
  "terminal.integrated.shellArgs.osx",
  "terminal.integrated.shellArgs.windows",
] as const;

interface PendingSetting {
  key: string;
  value: unknown;
  target: vscode.ConfigurationTarget.Workspace | vscode.ConfigurationTarget.WorkspaceFolder;
  folder?: vscode.WorkspaceFolder;
}

/**
 * Holds commands that start because a folder or a file was opened, and asks before they run.
 * Automatic tasks stay off, so the editor does not start a folder-open task ahead of the question.
 */
export class OpenGuard implements vscode.Disposable {
  private readonly allowed = new Set<string>();
  private readonly declined = new Set<string>();
  private readonly asking = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  private applying = false;
  private readonly subscriptions: vscode.Disposable[];

  constructor(private readonly log: vscode.LogOutputChannel) {
    this.subscriptions = [
      vscode.tasks.onDidStartTask((event) => this.onTask(event.execution)),
      vscode.tasks.onDidStartTaskProcess((event) => this.onTask(event.execution)),
      vscode.window.onDidOpenTerminal((terminal) => this.onTerminal(terminal)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.sweep()),
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        this.declined.clear();
        void this.sweep();
      }),
      vscode.workspace.onDidChangeConfiguration(() => void this.sweep()),
    ];
    void this.sweep();
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }

  private async sweep(): Promise<void> {
    if (this.applying) {
      return;
    }
    this.applying = true;
    try {
      await this.holdAutomaticTasks();
      await this.holdTerminalSettings();
      await this.askFolderTasks();
    } catch (error) {
      this.log.warn(`saw could not hold a command that starts on open: ${String(error)}`);
    } finally {
      this.applying = false;
    }
  }

  private async holdAutomaticTasks(): Promise<void> {
    await this.clearProject(AUTOMATIC_TASKS);
    const current = vscode.workspace.getConfiguration().inspect(AUTOMATIC_TASKS)?.globalValue;
    if (current !== "off") {
      await vscode.workspace.getConfiguration().update(AUTOMATIC_TASKS, "off", vscode.ConfigurationTarget.Global);
      this.log.info("Tasks that run because a folder opened wait for a confirmation.");
    }
  }

  private async holdTerminalSettings(): Promise<void> {
    for (const key of TERMINAL_SETTINGS) {
      await this.holdSetting(key, vscode.ConfigurationTarget.Workspace);
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (folder.uri.scheme === "file") {
          await this.holdSetting(key, vscode.ConfigurationTarget.WorkspaceFolder, folder);
        }
      }
    }
  }

  private async holdSetting(key: string, target: PendingSetting["target"], folder?: vscode.WorkspaceFolder): Promise<void> {
    const inspected = vscode.workspace.getConfiguration(undefined, folder?.uri).inspect(key);
    const value = target === vscode.ConfigurationTarget.Workspace ? inspected?.workspaceValue : inspected?.workspaceFolderValue;
    if (value === undefined) {
      return;
    }
    const stamp = `${key}\0${folder?.uri.fsPath ?? ""}\0${JSON.stringify(value)}`;
    if (this.allowed.has(stamp) || this.declined.has(stamp) || this.asking.has(stamp)) {
      return;
    }
    this.asking.add(stamp);
    await vscode.workspace.getConfiguration(undefined, folder?.uri).update(key, undefined, target);
    this.enqueue(stamp, terminalSettingQuestion(settingSummary(value)), "Allow", async () => {
      await vscode.workspace.getConfiguration(undefined, folder?.uri).update(key, value, target);
    });
  }

  private async clearProject(key: string): Promise<void> {
    const workspace = vscode.workspace.getConfiguration().inspect(key);
    if (workspace?.workspaceValue !== undefined) {
      await vscode.workspace.getConfiguration().update(key, undefined, vscode.ConfigurationTarget.Workspace);
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== "file") {
        continue;
      }
      const inspected = vscode.workspace.getConfiguration(undefined, folder.uri).inspect(key);
      if (inspected?.workspaceFolderValue !== undefined) {
        await vscode.workspace.getConfiguration(undefined, folder.uri).update(key, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
      }
    }
  }

  private async askFolderTasks(): Promise<void> {
    const tasks = await vscode.tasks.fetchTasks();
    for (const task of tasks) {
      if (isFolderOpenRun(runOn(task))) {
        this.considerTask(task);
      }
    }
  }

  private onTask(execution: vscode.TaskExecution): void {
    const task = execution.task;
    if (!isFolderOpenRun(runOn(task))) {
      return;
    }
    const key = taskKey(task);
    if (this.allowed.has(key)) {
      return;
    }
    execution.terminate();
    this.considerTask(task);
  }

  private considerTask(task: vscode.Task): void {
    const key = taskKey(task);
    if (this.allowed.has(key) || this.asking.has(key) || this.settled(key)) {
      return;
    }
    this.asking.add(key);
    const command = commandOf(task.execution);
    const trusted = vscode.workspace.isTrusted;
    this.enqueue(key, trusted ? openRunQuestion(task.name, command) : heldQuestion(task.name, command), "Run", async () => {
      await vscode.tasks.executeTask(task);
    });
  }

  private onTerminal(terminal: vscode.Terminal): void {
    const options = terminal.creationOptions;
    if (!options || "pty" in options) {
      return;
    }
    const shellPath = typeof options.shellPath === "string" ? options.shellPath : "";
    const args = shellArgs(options.shellArgs);
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === "file").map((folder) => folder.uri.fsPath);
    if (!shellUsesFolder(shellPath, args, folders)) {
      return;
    }
    const key = openRunKey("terminal", shellPath, args.join(" "), "");
    if (this.allowed.has(key)) {
      return;
    }
    terminal.dispose();
    if (this.declined.has(key) || this.asking.has(key)) {
      return;
    }
    this.asking.add(key);
    const trusted = vscode.workspace.isTrusted;
    this.enqueue(key, trusted ? shellQuestion(shellPath, args) : shellHeldQuestion(shellPath, args), "Run", () => {
      vscode.window.createTerminal({ ...options });
    });
  }

  /** One question at a time. Dismissing it leaves the command unrun for this window. */
  private enqueue(key: string, question: string, accept: string, run: () => Promise<void> | void): void {
    this.chain = this.chain.then(async () => {
      try {
        if (!vscode.workspace.isTrusted) {
          if (!this.declined.has(key)) {
            this.declined.add(key);
            await vscode.window.showWarningMessage(question, { modal: true });
          }
          return;
        }
        const choice = await vscode.window.showWarningMessage(question, { modal: true }, accept);
        if (choice === accept) {
          this.allowed.add(key);
          await run();
        } else {
          this.declined.add(key);
        }
      } catch (error) {
        this.declined.add(key);
        this.log.warn(`saw could not ask about a command that starts on open: ${String(error)}`);
      } finally {
        this.asking.delete(key);
      }
    });
  }

  /** A no from this window, unless trust was just granted and those nos were cleared. */
  private settled(key: string): boolean {
    return this.declined.has(key);
  }
}

function runOn(task: vscode.Task): unknown {
  return (task.runOptions as { runOn?: unknown } | undefined)?.runOn;
}

function taskKey(task: vscode.Task): string {
  const scope = task.scope;
  const folder = scope && typeof scope === "object" && "uri" in scope ? scope.uri.fsPath : "";
  return openRunKey(folder, task.source, task.name, commandOf(task.execution));
}

function commandOf(execution: vscode.Task["execution"]): string {
  if (!execution) {
    return "";
  }
  if ("process" in execution && typeof execution.process === "string") {
    return [execution.process, ...execution.args].join(" ");
  }
  if ("commandLine" in execution && typeof execution.commandLine === "string" && execution.commandLine !== "") {
    return execution.commandLine;
  }
  if ("command" in execution) {
    const command = typeof execution.command === "string" ? execution.command : execution.command?.value;
    const args = (execution.args ?? []).map((arg) => (typeof arg === "string" ? arg : arg.value));
    return [command ?? "", ...args].filter(Boolean).join(" ");
  }
  return "";
}

function shellArgs(value: string | readonly string[] | undefined): string[] {
  if (!value) {
    return [];
  }
  return typeof value === "string" ? [value] : [...value];
}
