import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";

import * as vscode from "vscode";

import type { AmendOutcome, FixOutcome } from "../../core/fix/actions";
import { prose } from "../../core/report/markdown";
import { detailsPage, linkTarget } from "../../core/report/page";
import { amendReport, auditReport, fixReport, heldReport, hooksReport, scanReport, watchReport, when, type CommandRun, type Copy } from "../../core/report/reports";
import { behindVersion } from "../../core/install/upgrade";
import type { Model, Settled } from "../model";

export const REPORT_SCHEME = "saw-report";

type Kind = "scan" | "fix" | "amend" | "held" | "audit" | "hooks" | "watch";

/** The two ways saw fixes an infection: `saw fix` for the files, `saw fix amend` for git history. */
export type Treatment = "files" | "history";

const FIXES_KEPT = 5;

const MACHINE_TITLE = { audit: "Before you change passwords", hooks: "Checks on clone and pull", watch: "Background checks" } as const;
const FOLDER_TITLE = { scan: "Full details", fix: "Files fix details", amend: "Git history fix details", held: "Held update details" } as const;
const REFRESH_MS = 300;

interface FixRecord {
  run: CommandRun;
  outcome: FixOutcome | undefined;
  decisions: string[];
}

interface AmendRecord {
  run: CommandRun;
  outcome: AmendOutcome | undefined;
  decisions: string[];
}

function folderKey(folder: vscode.WorkspaceFolder): string {
  return createHash("sha256").update(folder.uri.toString()).digest("hex").slice(0, 16);
}

/** A folder name as a tab title: letters, digits and a few separators only. */
function label(name: string): string {
  return name.replace(/[^\w.-]+/g, "_").slice(0, 60) || "folder";
}

/** A details tab and the last page it was given, so a redraw that changes nothing is skipped. */
interface DetailsTab {
  panel: vscode.WebviewPanel;
  uri: vscode.Uri;
  nonce: string;
  html?: string;
}

/**
 * saw's reports as read-only Markdown documents, each shown in a details tab of its own. Each is
 * built from what the extension knows now, so it follows a scan or a command as it runs. A copy
 * without evidence is kept in the extension's own storage, never in the project, and shown when
 * this window has nothing newer.
 */
export class Reports implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changed.event;
  /** Reports something has read, with the time each last changed, so they can be told to re-read. */
  private readonly watched = new Map<string, { uri: vscode.Uri; mtime: number }>();
  private readonly tabs = new Map<string, DetailsTab>();
  private readonly fixes = new Map<string, FixRecord>();
  private readonly amends = new Map<string, AmendRecord>();
  private readonly savedScans = new Map<string, Settled>();
  private auditRun: CommandRun | undefined;
  private watchRun: CommandRun | undefined;
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
    private readonly icon?: { light: vscode.Uri; dark: vscode.Uri },
  ) {
    this.subscriptions = [
      vscode.workspace.registerFileSystemProvider(REPORT_SCHEME, this, { isReadonly: true, isCaseSensitive: true }),
      model.onDidChange(() => this.modelChanged()),
    ];
  }

  scanUri(folder: vscode.WorkspaceFolder): vscode.Uri {
    return vscode.Uri.from({ scheme: REPORT_SCHEME, path: `/scan/${folderKey(folder)}/Full details - ${label(folder.name)}.md` });
  }

  /** The files fix this window finished for the folder, when it prepared one. */
  lastFix(folder: vscode.WorkspaceFolder): FixOutcome | undefined {
    const outcome = this.fixes.get(folderKey(folder))?.outcome;
    return outcome?.kind === "prepared" ? outcome : undefined;
  }

  fixUri(folder: vscode.WorkspaceFolder): vscode.Uri {
    return vscode.Uri.from({ scheme: REPORT_SCHEME, path: `/fix/${folderKey(folder)}/Files fix details - ${label(folder.name)}.md` });
  }

  /** The git history fix this window ran for the folder: running, or how it ended. */
  lastAmend(folder: vscode.WorkspaceFolder): AmendOutcome | "running" | undefined {
    const record = this.amends.get(folderKey(folder));
    return record && (record.run.finishedAt === undefined ? "running" : (record.outcome ?? { kind: "failed" }));
  }

  amendUri(folder: vscode.WorkspaceFolder): vscode.Uri {
    return vscode.Uri.from({ scheme: REPORT_SCHEME, path: `/amend/${folderKey(folder)}/Git history fix details - ${label(folder.name)}.md` });
  }

  /** What saw found in an update it held for the folder, and what to do about it. */
  heldUri(folder: vscode.WorkspaceFolder): vscode.Uri {
    return vscode.Uri.from({ scheme: REPORT_SCHEME, path: `/held/${folderKey(folder)}/Held update details - ${label(folder.name)}.md` });
  }

  machineUri(kind: "audit" | "hooks" | "watch"): vscode.Uri {
    return vscode.Uri.from({ scheme: REPORT_SCHEME, path: `/${kind}/machine/${MACHINE_TITLE[kind]}.md` });
  }

  /** Ask which report to open: each folder's scan, each fix run in this window, and the machine's. */
  async choose(): Promise<vscode.Uri | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const items: Array<vscode.QuickPickItem & { uri: vscode.Uri }> = [
      ...folders.map((folder) => ({ label: `$(shield) ${folder.name}`, description: "scan results", uri: this.scanUri(folder) })),
      ...folders.filter((folder) => this.fixes.has(folderKey(folder))).map((folder) => ({ label: `$(wand) ${folder.name}`, description: "files fix", uri: this.fixUri(folder) })),
      ...folders.filter((folder) => this.amends.has(folderKey(folder))).map((folder) => ({ label: `$(history) ${folder.name}`, description: "git history fix", uri: this.amendUri(folder) })),
      { label: "$(device-desktop) Before you change passwords", description: "this machine", uri: this.machineUri("audit") },
      { label: "$(git-merge) Checks on clone and pull", description: "this machine", uri: this.machineUri("hooks") },
      { label: "$(eye) Background checks", description: "this machine", uri: this.machineUri("watch") },
    ];
    return (await vscode.window.showQuickPick(items, { placeHolder: "Details to open" }))?.uri;
  }

  /** Open a report in its own tab, or bring that tab forward. */
  async open(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    const open = this.tabs.get(key);
    if (open) {
      open.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel("saw.details", this.title(uri), vscode.ViewColumn.Active, { enableScripts: true });
    if (this.icon) {
      panel.iconPath = this.icon;
    }
    const tab: DetailsTab = { panel, uri, nonce: Math.random().toString(36).slice(2) };
    this.tabs.set(key, tab);
    const messages = panel.webview.onDidReceiveMessage((message: { link?: unknown }) => {
      const target = linkTarget(message?.link);
      if (target) {
        void vscode.env.openExternal(vscode.Uri.parse(target));
      }
    });
    const gone = panel.onDidDispose(() => {
      messages.dispose();
      gone.dispose();
      if (this.tabs.get(key) === tab) {
        this.tabs.delete(key);
      }
    });
    await this.draw(tab);
  }

  private title(uri: vscode.Uri): string {
    const [, kind, key] = uri.path.split("/") as [string, Kind, string];
    if (kind === "audit" || kind === "hooks" || kind === "watch") {
      return MACHINE_TITLE[kind];
    }
    const folder = (vscode.workspace.workspaceFolders ?? []).find((f) => folderKey(f) === key);
    return folder ? `${FOLDER_TITLE[kind]} · ${folder.name}` : FOLDER_TITLE[kind];
  }

  private async draw(tab: DetailsTab): Promise<void> {
    const html = detailsPage(await this.content(tab.uri), tab.nonce);
    if (tab.html !== html && this.tabs.get(tab.uri.toString()) === tab) {
      tab.html = html;
      tab.panel.webview.html = html;
    }
  }

  // --- what the actions tell it ---------------------------------------------------------------------

  fixStarted(folder: vscode.WorkspaceFolder, run: CommandRun): void {
    this.fixes.set(folderKey(folder), { run, outcome: undefined, decisions: [] });
    this.changedSoon();
  }

  /** Choices made so far in the fix that is running. */
  fixDecisions(folder: vscode.WorkspaceFolder, decisions: readonly string[], treatment: Treatment = "files"): void {
    const record = (treatment === "history" ? this.amends : this.fixes).get(folderKey(folder));
    if (record) {
      record.decisions = [...decisions];
      this.changedSoon();
    }
  }

  fixFinished(folder: vscode.WorkspaceFolder, outcome: FixOutcome | undefined): void {
    const record = this.fixes.get(folderKey(folder));
    if (record) {
      record.outcome = outcome;
      void this.save(this.fixPath(folder, record.run.startedAt), fixReport(this.fixInput(folder, record), "saved"), this.fixDir(folder));
    }
    this.changedSoon();
  }

  amendStarted(folder: vscode.WorkspaceFolder, run: CommandRun): void {
    this.amends.set(folderKey(folder), { run, outcome: undefined, decisions: [] });
    this.changedSoon();
  }

  amendFinished(folder: vscode.WorkspaceFolder, outcome: AmendOutcome | undefined): void {
    const record = this.amends.get(folderKey(folder));
    if (record) {
      record.outcome = outcome;
      void this.save(this.amendPath(folder, record.run.startedAt), amendReport(this.fixInput(folder, record), "saved"), this.amendDir(folder));
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

  watchStarted(run: CommandRun): void {
    this.watchRun = run;
    this.changedSoon();
  }

  watchFinished(): void {
    void this.save(this.machinePath("watch"), this.render("watch", undefined, "saved"));
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
    if (!["scan", "fix", "amend", "held", "audit", "hooks", "watch"].includes(kind ?? "") || !uri.path.endsWith(".md")) {
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
    return this.render(kind, folder, "shown");
  }

  /** The report from this window's own state, or undefined when the window has none yet. */
  private live(kind: Kind, folder: vscode.WorkspaceFolder | undefined): string | undefined {
    switch (kind) {
      case "scan": {
        if (!folder) return "# saw scan\n\nThis folder is no longer open in this window.";
        const state = this.model.get(folder);
        return state.last || state.scanning || state.fixing ? this.render(kind, folder, "shown") : undefined;
      }
      case "fix":
        if (!folder) return "# saw fix\n\nThis folder is no longer open in this window.";
        return this.fixes.has(folderKey(folder)) ? this.render(kind, folder, "shown") : undefined;
      case "amend":
        if (!folder) return "# saw fix amend\n\nThis folder is no longer open in this window.";
        return this.amends.has(folderKey(folder)) ? this.render(kind, folder, "shown") : undefined;
      case "held":
        if (!folder) return "# Held update\n\nThis folder is no longer open in this window.";
        return this.render(kind, folder, "shown");
      case "audit":
        return this.auditRun ? this.render(kind, undefined, "shown") : undefined;
      case "hooks":
        return this.model.machine.hooks || this.hooksChange ? this.render(kind, undefined, "shown") : undefined;
      case "watch":
        return this.watchRun ? this.render(kind, undefined, "shown") : undefined;
    }
  }

  private render(kind: Kind, folder: vscode.WorkspaceFolder | undefined, copy: Copy): string {
    const engine = this.model.engine;
    const sawVersion = shownVersion(engine);
    switch (kind) {
      case "scan": {
        if (!folder) return "# saw scan";
        const state = this.model.get(folder);
        return scanReport({ folderName: folder.name, folderPath: folder.uri.fsPath, scanning: state.scanning, fixing: state.fixing, step: state.scanning ? state.progress : undefined, outcome: state.last, sawVersion: state.scannedBy ? behindVersion(state.scannedBy.version, state.scannedBy.behind) : sawVersion }, copy);
      }
      case "fix": {
        const record = folder && this.fixes.get(folderKey(folder));
        if (!folder || !record) return "# saw fix\n\nsaw has not fixed the files of this folder from this window. Use **Fix infection in files** on an infected folder in Chat.";
        return fixReport(this.fixInput(folder, record), copy);
      }
      case "amend": {
        const record = folder && this.amends.get(folderKey(folder));
        if (!folder || !record) return "# saw fix amend\n\nsaw has not fixed the git history of this folder from this window. Use **Fix infection in git history** in the folder's scan results.";
        return amendReport(this.fixInput(folder, record), copy);
      }
      case "held": {
        if (!folder) return "# Held update";
        const held = this.model.get(folder).held;
        const shown = held && !held.released ? held : undefined;
        return heldReport({ folderName: folder.name, folderPath: folder.uri.fsPath, held: shown, details: shown?.details }, copy);
      }
      case "audit": {
        const audit = this.model.machine.audit;
        const finished = this.auditRun?.finishedAt !== undefined;
        return auditReport({ run: this.auditRun, verdict: finished ? audit?.verdict : undefined, sentence: finished ? audit?.sentence : undefined, details: finished ? audit?.details : undefined, step: finished ? undefined : this.model.machine.auditProgress, sawVersion }, copy);
      }
      case "hooks":
        return hooksReport({
          status: this.model.machine.hooks,
          checkedAt: this.hooksCheckedAt,
          change: this.hooksChange && { ...this.hooksChange.run, subcommand: this.hooksChange.subcommand },
          sawVersion,
        }, copy);
      case "watch":
        return watchReport({ run: this.watchRun, sawVersion }, copy);
    }
  }

  private fixInput<R extends FixRecord | AmendRecord>(folder: vscode.WorkspaceFolder, record: R): R & { folderName: string; folderPath: string; sawVersion: string | undefined } {
    const engine = this.model.engine;
    return { ...record, folderName: folder.name, folderPath: folder.uri.fsPath, sawVersion: shownVersion(engine) };
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
      for (const tab of this.tabs.values()) {
        void this.draw(tab);
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

  private amendDir(folder: vscode.WorkspaceFolder): string | undefined {
    const dir = this.folderDir(folder);
    return dir && path.join(dir, "amends");
  }

  private amendPath(folder: vscode.WorkspaceFolder, startedAt: number): string | undefined {
    const dir = this.amendDir(folder);
    return dir && path.join(dir, `${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}.md`);
  }

  private machinePath(kind: "audit" | "hooks" | "watch"): string {
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
    if (kind === "audit" || kind === "hooks" || kind === "watch") {
      file = this.machinePath(kind);
    } else if (folder && kind === "scan") {
      file = this.scanPath(folder);
    } else if (folder) {
      const dir = kind === "amend" ? this.amendDir(folder) : this.fixDir(folder);
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
    for (const tab of this.tabs.values()) {
      tab.panel.dispose();
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.subscriptions.forEach((s) => s.dispose());
    this.changed.dispose();
  }
}

/** The saw that ran, and the release it stands in for when it is older than the pin. */
function shownVersion(engine: Model["engine"]): string | undefined {
  if (engine?.kind !== "ready") {
    return undefined;
  }
  return behindVersion(engine.version, engine.behind);
}
