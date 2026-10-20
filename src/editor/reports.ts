import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";

import * as vscode from "vscode";

import type { FixOutcome } from "../core/actions";
import { prose } from "../core/markdown";
import { auditReport, fixReport, hooksReport, scanReport, when, type CommandRun, type Copy } from "../core/reports";
import type { Model, Settled } from "./model";

export const REPORT_SCHEME = "saw-report";

type Kind = "scan" | "fix" | "audit" | "hooks";

const FIXES_KEPT = 5;
const REFRESH_MS = 300;

interface FixRecord {
  run: CommandRun;
  outcome: FixOutcome | undefined;
}

function folderKey(folder: vscode.WorkspaceFolder): string {
  return createHash("sha256").update(folder.uri.toString()).digest("hex").slice(0, 16);
}

/** A folder name as a tab title: letters, digits and a few separators only. */
function label(name: string): string {
  return name.replace(/[^\w.-]+/g, "_").slice(0, 60) || "folder";
}

/**
 * saw's reports as read-only Markdown documents, opened in the editor's Markdown preview. Each is
 * built from what the extension knows now, so it follows a scan or a command as it runs. A copy
 * without evidence is kept in the extension's own storage, never in the project, and shown when
 * this window has nothing newer.
 */
export class Reports implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changed.event;
  /** Reports something has read, with the time each last changed, so they can be told to re-read. */
  private readonly watched = new Map<string, { uri: vscode.Uri; mtime: number }>();
  private readonly fixes = new Map<string, FixRecord>();
  private readonly savedScans = new Map<string, Settled>();
  private auditRun: CommandRun | undefined;
  private hooksChange: { subcommand: "install" | "repair"; run: CommandRun } | undefined;
  private hooksCheckedAt: number | undefined;
  private savedHooks: unknown;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly model: Model,
    /** Per-workspace storage; undefined when no workspace is open, and reports then stay in memory. */
    private readonly workspaceStorage: string | undefined,
    private readonly globalStorage: string,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.subscriptions = [
      vscode.workspace.registerFileSystemProvider(REPORT_SCHEME, this, { isReadonly: true, isCaseSensitive: true }),
      model.onDidChange(() => this.modelChanged()),
    ];
  }

  scanUri(folder: vscode.WorkspaceFolder): vscode.Uri {
    return vscode.Uri.from({ scheme: REPORT_SCHEME, path: `/scan/${folderKey(folder)}/saw scan - ${label(folder.name)}.md` });
  }

  fixUri(folder: vscode.WorkspaceFolder): vscode.Uri {
    return vscode.Uri.from({ scheme: REPORT_SCHEME, path: `/fix/${folderKey(folder)}/saw fix - ${label(folder.name)}.md` });
  }

  machineUri(kind: "audit" | "hooks"): vscode.Uri {
    return vscode.Uri.from({ scheme: REPORT_SCHEME, path: `/${kind}/machine/saw ${kind}.md` });
  }

  /** Ask which report to open: each folder's scan, each fix run in this window, and the machine's. */
  async choose(): Promise<vscode.Uri | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const items: Array<vscode.QuickPickItem & { uri: vscode.Uri }> = [
      ...folders.map((folder) => ({ label: `$(shield) ${folder.name}`, description: "scan", uri: this.scanUri(folder) })),
      ...folders.filter((folder) => this.fixes.has(folderKey(folder))).map((folder) => ({ label: `$(wand) ${folder.name}`, description: "last fix", uri: this.fixUri(folder) })),
      { label: "$(device-desktop) This machine", description: "audit", uri: this.machineUri("audit") },
      { label: "$(git-merge) This machine", description: "scan-on-clone hooks", uri: this.machineUri("hooks") },
    ];
    return (await vscode.window.showQuickPick(items, { placeHolder: "saw report to open" }))?.uri;
  }

  async open(uri: vscode.Uri): Promise<void> {
    await vscode.commands.executeCommand("markdown.showPreview", uri);
  }

  // --- what the actions tell it ---------------------------------------------------------------------

  fixStarted(folder: vscode.WorkspaceFolder, run: CommandRun): void {
    this.fixes.set(folderKey(folder), { run, outcome: undefined });
    this.changedSoon();
  }

  fixFinished(folder: vscode.WorkspaceFolder, outcome: FixOutcome | undefined): void {
    const record = this.fixes.get(folderKey(folder));
    if (record) {
      record.outcome = outcome;
      void this.save(this.fixPath(folder, record.run.startedAt), fixReport(this.fixInput(folder, record), "saved"), this.fixDir(folder));
    }
    this.changedSoon();
  }

  auditStarted(run: CommandRun): void {
    this.auditRun = run;
    this.changedSoon();
  }

  auditFinished(): void {
    void this.save(this.machinePath("audit"), this.render("audit", undefined, "saved"));
    this.changedSoon();
  }

  hooksChangeStarted(subcommand: "install" | "repair", run: CommandRun): void {
    this.hooksChange = { subcommand, run };
    this.changedSoon();
  }

  /** A running command's output grew, or it finished: the run object it was given has changed. */
  progressed(): void {
    this.changedSoon();
  }

  // --- rendering ------------------------------------------------------------------------------------

  // --- the read-only file system the editor reads reports through ----------------------------------

  stat(uri: vscode.Uri): vscode.FileStat {
    const kind = uri.path.split("/")[1];
    if (!["scan", "fix", "audit", "hooks"].includes(kind ?? "") || !uri.path.endsWith(".md")) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    const mtime = this.watched.get(uri.toString())?.mtime ?? Date.now();
    return { type: vscode.FileType.File, ctime: 0, mtime, size: 0, permissions: vscode.FilePermission.Readonly };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const key = uri.toString();
    if (!this.watched.has(key)) {
      this.watched.set(key, { uri, mtime: Date.now() });
    }
    return new TextEncoder().encode(await this.content(uri));
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  writeFile(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  private async content(uri: vscode.Uri): Promise<string> {
    const [, kind, key] = uri.path.split("/") as [string, Kind, string];
    const folder = (vscode.workspace.workspaceFolders ?? []).find((f) => folderKey(f) === key);
    const live = this.live(kind, folder);
    if (live !== undefined) {
      return live;
    }
    const saved = await this.readSaved(kind, folder);
    if (saved) {
      return saved;
    }
    return this.render(kind, folder, "preview");
  }

  /** The report from this window's own state, or undefined when the window has none yet. */
  private live(kind: Kind, folder: vscode.WorkspaceFolder | undefined): string | undefined {
    switch (kind) {
      case "scan": {
        if (!folder) return "# saw scan\n\nThis folder is no longer open in this window.";
        const state = this.model.get(folder);
        return state.last || state.scanning || state.fixing ? this.render(kind, folder, "preview") : undefined;
      }
      case "fix":
        if (!folder) return "# saw fix\n\nThis folder is no longer open in this window.";
        return this.fixes.has(folderKey(folder)) ? this.render(kind, folder, "preview") : undefined;
      case "audit":
        return this.auditRun ? this.render(kind, undefined, "preview") : undefined;
      case "hooks":
        return this.model.machine.hooks || this.hooksChange ? this.render(kind, undefined, "preview") : undefined;
    }
  }

  private render(kind: Kind, folder: vscode.WorkspaceFolder | undefined, copy: Copy): string {
    const engine = this.model.engine;
    const sawVersion = engine?.kind === "ready" ? engine.version : undefined;
    switch (kind) {
      case "scan": {
        if (!folder) return "# saw scan";
        const state = this.model.get(folder);
        return scanReport({ folderName: folder.name, folderPath: folder.uri.fsPath, scanning: state.scanning, fixing: state.fixing, outcome: state.last, sawVersion }, copy);
      }
      case "fix": {
        const record = folder && this.fixes.get(folderKey(folder));
        if (!folder || !record) return "# saw fix\n\nsaw has not fixed this folder from this window. Use **Fix…** on an infected folder in the saw view.";
        return fixReport(this.fixInput(folder, record), copy);
      }
      case "audit": {
        const audit = this.model.machine.audit;
        const finished = this.auditRun?.finishedAt !== undefined;
        return auditReport({ run: this.auditRun, verdict: finished ? audit?.verdict : undefined, sentence: finished ? audit?.sentence : undefined, details: finished ? audit?.details : undefined, sawVersion }, copy);
      }
      case "hooks":
        return hooksReport({
          status: this.model.machine.hooks,
          checkedAt: this.hooksCheckedAt,
          change: this.hooksChange && { ...this.hooksChange.run, subcommand: this.hooksChange.subcommand },
          sawVersion,
        }, copy);
    }
  }

  private fixInput(folder: vscode.WorkspaceFolder, record: FixRecord) {
    const engine = this.model.engine;
    return { folderName: folder.name, folderPath: folder.uri.fsPath, run: record.run, outcome: record.outcome, sawVersion: engine?.kind === "ready" ? engine.version : undefined };
  }

  private modelChanged(): void {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const last = this.model.get(folder).last;
      if (last && this.savedScans.get(folderKey(folder)) !== last) {
        this.savedScans.set(folderKey(folder), last);
        void this.save(this.scanPath(folder), this.render("scan", folder, "saved"), this.folderDir(folder));
      }
    }
    if (this.model.machine.hooks && this.model.machine.hooks !== this.savedHooks) {
      this.savedHooks = this.model.machine.hooks;
      this.hooksCheckedAt = Date.now();
      void this.save(this.machinePath("hooks"), this.render("hooks", undefined, "saved"));
    }
    this.changedSoon();
  }

  /** Tell every open report to re-render, at most a few times a second. */
  private changedSoon(): void {
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const now = Date.now();
      const events = [...this.watched.values()].map((entry) => {
        entry.mtime = Math.max(now, entry.mtime + 1);
        return { type: vscode.FileChangeType.Changed, uri: entry.uri };
      });
      if (events.length) {
        this.changed.fire(events);
      }
    }, REFRESH_MS);
  }

  // --- the copies kept in the extension's storage ---------------------------------------------------

  private folderDir(folder: vscode.WorkspaceFolder): string | undefined {
    return this.workspaceStorage && path.join(this.workspaceStorage, "reports", folderKey(folder));
  }

  /** Where the copy of a folder's scan report is kept, when this window has workspace storage. */
  scanPath(folder: vscode.WorkspaceFolder): string | undefined {
    const dir = this.folderDir(folder);
    return dir && path.join(dir, "scan.md");
  }

  private fixDir(folder: vscode.WorkspaceFolder): string | undefined {
    const dir = this.folderDir(folder);
    return dir && path.join(dir, "fixes");
  }

  private fixPath(folder: vscode.WorkspaceFolder, startedAt: number): string | undefined {
    const dir = this.fixDir(folder);
    return dir && path.join(dir, `${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}.md`);
  }

  private machinePath(kind: "audit" | "hooks"): string {
    return path.join(this.globalStorage, "reports", `${kind}.md`);
  }

  /** Write a copy, through a temporary file so a reader never sees half of it, and prune old fixes. */
  private async save(file: string | undefined, text: string, pruneDir?: string): Promise<void> {
    if (!file) {
      return;
    }
    try {
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, text, "utf8");
      await rename(temporary, file);
      if (pruneDir) {
        const old = (await readdir(pruneDir)).filter((name) => name.endsWith(".md")).sort().slice(0, -FIXES_KEPT);
        await Promise.all(old.map((name) => rm(path.join(pruneDir, name), { force: true })));
      }
    } catch (error) {
      this.log.warn(`could not keep a copy of the report: ${String(error)}`);
    }
  }

  private async readSaved(kind: Kind, folder: vscode.WorkspaceFolder | undefined): Promise<string | undefined> {
    let file: string | undefined;
    if (kind === "audit" || kind === "hooks") {
      file = this.machinePath(kind);
    } else if (folder && kind === "scan") {
      file = this.scanPath(folder);
    } else if (folder) {
      const dir = this.fixDir(folder);
      const newest = dir && (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".md")).sort().at(-1);
      file = dir && newest ? path.join(dir, newest) : undefined;
    }
    if (!file) {
      return undefined;
    }
    try {
      const [text, info] = await Promise.all([readFile(file, "utf8"), stat(file)]);
      const banner = `> **Saved ${prose(when(info.mtimeMs), 40)}, in an earlier session.** Nothing newer has run in this window yet. Saved copies withhold evidence.`;
      return `${banner}\n\n${text}`;
    } catch {
      return undefined;
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.subscriptions.forEach((s) => s.dispose());
    this.changed.dispose();
  }
}
