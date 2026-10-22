import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import * as vscode from "vscode";

import { agentReport } from "../../core/agent/agent";
import { hooksJson, recordName, shellQuote, type GuardRecord } from "../../core/agent/guard";
import { describeFolder } from "./agentTool";
import type { FolderState, Model } from "../model";
import type { Settings } from "../settings";

/** Cursor's extension API for plugin directories; absent from VS Code and its types. */
interface CursorPlugins {
  add(path: string): unknown;
  remove(path: string): unknown;
}

interface CursorPluginsApi {
  /** As Cursor documents it. */
  registerPath(path: string): unknown;
  unregisterPath(path: string): unknown;
  /** As Cursor 3.26 ships it. */
  addPlugin(plugin: { path: string }): unknown;
  removePlugin(plugin: { path: string }): unknown;
}

function cursorPlugins(): CursorPlugins | undefined {
  const api = (vscode as unknown as { cursor?: { plugins?: Partial<CursorPluginsApi> } }).cursor?.plugins;
  if (typeof api?.registerPath === "function" && typeof api.unregisterPath === "function") {
    return { add: (path) => api.registerPath?.(path), remove: (path) => api.unregisterPath?.(path) };
  }
  if (typeof api?.addPlugin === "function" && typeof api.removePlugin === "function") {
    return { add: (path) => api.addPlugin?.({ path }), remove: (path) => api.removePlugin?.({ path }) };
  }
  return undefined;
}

/** What the hook reads about a folder: the latest finished scan, kept while a rescan runs. */
function record(state: FolderState, model: Model): Omit<GuardRecord, "updatedAt"> {
  const settledNow = { ...state, scanning: false, fixing: false };
  return {
    path: state.folder.uri.fsPath,
    name: state.folder.name,
    verdict: state.last?.verdict,
    report: agentReport([describeFolder(settledNow, model.engine)]),
  };
}

/**
 * In Cursor, a plugin whose `beforeShellExecution` hook asks saw's verdict before the agent runs a
 * command that installs or runs a folder's code. This window writes each folder's verdict where the
 * hook reads it, and removes its records when it closes.
 */
export class CursorAgentGuard implements vscode.Disposable {
  private readonly plugins = cursorPlugins();
  readonly pluginDir: string;
  private readonly store: string;
  private readonly window = vscode.env.sessionId;
  /** Whether Cursor has been given the guard's plugin. */
  registered = false;
  private readonly written = new Map<string, string>();
  private readonly subscription: vscode.Disposable | undefined;

  constructor(
    private readonly model: Model,
    private readonly settings: () => Settings,
    storage: string,
    private readonly hookScript: string,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.pluginDir = path.join(storage, "saw-agent-guard");
    this.store = path.join(storage, "cursor-verdicts");
    // Hooks run as a POSIX shell command, and where Cursor runs them in a remote window is not documented.
    if (!this.plugins || process.platform === "win32" || vscode.env.remoteName) {
      return;
    }
    this.subscription = model.onDidChange(() => this.update());
    this.update();
  }

  private update(): void {
    try {
      if (!this.settings().guardAgentCommands) {
        this.stop();
        return;
      }
      if (!this.registered) {
        this.start();
      }
      this.writeRecords();
    } catch (error) {
      this.log.warn(`Could not update saw's guard for Cursor's agent: ${String(error)}`);
    }
  }

  private start(): void {
    const command = `env ELECTRON_RUN_AS_NODE=1 ${shellQuote(process.execPath)} ${shellQuote(this.hookScript)} ${shellQuote(this.store)}`;
    mkdirSync(path.join(this.pluginDir, ".cursor-plugin"), { recursive: true });
    mkdirSync(path.join(this.pluginDir, "hooks"), { recursive: true });
    mkdirSync(this.store, { recursive: true });
    writeFileSync(
      path.join(this.pluginDir, ".cursor-plugin", "plugin.json"),
      JSON.stringify({ name: "saw-agent-guard", description: "Checks saw's verdict before the agent installs or runs a folder's code.", version: "1.0.0" }, null, 2),
    );
    writeFileSync(path.join(this.pluginDir, "hooks", "hooks.json"), hooksJson(command));
    void Promise.resolve(this.plugins?.add(this.pluginDir)).catch((error: unknown) => this.log.warn(`Cursor did not load saw's guard: ${String(error)}`));
    this.registered = true;
    this.log.info("Cursor's agent now asks saw's verdict before it installs or runs a folder's code.");
  }

  private writeRecords(): void {
    const seen = new Set<string>();
    for (const state of this.model.states()) {
      if (state.folder.uri.scheme !== "file") {
        continue;
      }
      const name = recordName(state.folder.uri.fsPath, this.window);
      seen.add(name);
      const content = JSON.stringify(record(state, this.model));
      if (this.written.get(name) === content) {
        continue;
      }
      const file = path.join(this.store, name);
      writeFileSync(`${file}.tmp`, JSON.stringify({ ...JSON.parse(content), updatedAt: Date.now() }));
      renameSync(`${file}.tmp`, file);
      this.written.set(name, content);
    }
    for (const name of [...this.written.keys()]) {
      if (!seen.has(name)) {
        rmSync(path.join(this.store, name), { force: true });
        this.written.delete(name);
      }
    }
  }

  private removeRecords(): void {
    const suffix = recordName("", this.window).replace(/^[0-9a-f]+/, "");
    for (const name of safeList(this.store)) {
      if (name.endsWith(suffix)) {
        rmSync(path.join(this.store, name), { force: true });
      }
    }
    this.written.clear();
  }

  private stop(): void {
    if (this.registered) {
      try {
        void Promise.resolve(this.plugins?.remove(this.pluginDir)).catch(() => undefined);
      } catch (error) {
        this.log.warn(`Could not unregister saw's guard from Cursor: ${String(error)}`);
      }
      this.registered = false;
      this.log.info("Cursor's agent no longer asks saw's verdict before running commands.");
    }
    this.removeRecords();
  }

  dispose(): void {
    this.subscription?.dispose();
    try {
      this.stop();
    } catch {
      // The window is closing; a record left behind is replaced by the next window's.
    }
  }
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
