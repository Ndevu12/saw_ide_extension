import * as vscode from "vscode";

import { scanFolder } from "../core/scan";
import { Scheduler } from "../core/schedule";
import type { Alerts } from "./alerts";
import type { Diagnostics } from "./diagnostics";
import type { EngineResolver } from "./engine";
import type { FolderState, Model } from "./model";
import { VERDICT_LABEL } from "./present";
import type { Settings } from "./settings";

const DEBOUNCE_MS = 1500;
const SETTLE_POLL_MS = 250;

/** Scans workspace folders on request, one run per folder at a time, and hands each result to the views. */
export class Controller implements vscode.Disposable {
  private readonly scheduler: Scheduler;

  constructor(
    private readonly model: Model,
    private readonly engines: EngineResolver,
    private readonly diagnostics: Diagnostics,
    private readonly alerts: Alerts,
    private readonly settings: () => Settings,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.scheduler = new Scheduler((key, signal) => this.scan(key, signal), DEBOUNCE_MS);
  }

  request(folder: vscode.WorkspaceFolder, options: { immediate?: boolean } = {}): void {
    if (folder.uri.scheme !== "file") {
      return;
    }
    this.scheduler.request(folder.uri.toString(), options);
  }

  requestAll(options: { immediate?: boolean } = {}): void {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      this.request(folder, options);
    }
  }

  requestFor(uri: vscode.Uri): void {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder) {
      this.request(folder);
    }
  }

  /**
   * The folder's state once no scan or fix of it is due or running, scanning it first when it has
   * no result yet. Returns whatever the state is when `signal` aborts.
   */
  async settled(folder: vscode.WorkspaceFolder, signal: AbortSignal): Promise<FolderState> {
    const key = folder.uri.toString();
    if (!this.model.get(folder).last && !this.scheduler.isBusy(key)) {
      this.request(folder, { immediate: true });
    }
    while (!signal.aborted && (this.scheduler.isBusy(key) || this.model.get(folder).fixing)) {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
    }
    return this.model.get(folder);
  }

  forget(folder: vscode.WorkspaceFolder): void {
    this.scheduler.cancel(folder.uri.toString());
    this.diagnostics.clear(folder);
    this.model.remove(folder);
  }

  private async scan(key: string, signal: AbortSignal): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.toString() === key);
    // A fix rewrites the checkout as it goes; it asks for a scan of its own when it is done.
    if (!folder || this.model.get(folder).fixing) {
      return;
    }
    const engine = await this.engines.resolve();
    this.model.setEngine(engine);
    // Alerts are not awaited: a notification left open must not hold up the next scan.
    if (engine.kind !== "ready") {
      void this.alerts.engineUnavailable(engine);
      return;
    }
    const before = this.model.get(folder).last?.verdict;
    this.model.setScanning(folder, true);
    const settings = this.settings();
    const outcome = await scanFolder({
      binary: engine.binary,
      folder: folder.uri.fsPath,
      configPath: settings.configPath,
      timeoutMs: settings.timeoutMs,
      signal,
    });
    if (outcome.kind === "cancelled") {
      this.model.setScanning(folder, false);
      return;
    }
    this.model.setOutcome(folder, outcome);
    this.diagnostics.publish(folder, outcome);
    const took = `${(outcome.durationMs / 1000).toFixed(1)}s`;
    this.log.info(`${folder.name}: ${VERDICT_LABEL[outcome.verdict]} (${took})`);
    for (const reason of outcome.reasons) {
      this.log.warn(`${folder.name}: ${reason}`);
    }
    void this.alerts.verdictChanged(folder, before, outcome);
  }

  dispose(): void {
    this.scheduler.dispose();
  }
}
