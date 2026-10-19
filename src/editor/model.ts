import * as vscode from "vscode";

import type { ScanOutcome } from "../core/scan";
import { strongest, type FolderVerdict } from "../core/verdict";
import type { Engine } from "./engine";

export type Settled = Exclude<ScanOutcome, { kind: "cancelled" }>;

export interface FolderState {
  folder: vscode.WorkspaceFolder;
  scanning: boolean;
  last: Settled | undefined;
}

/** What every view shows: the engine's state and each folder's latest scan. */
export class Model implements vscode.Disposable {
  private readonly folders = new Map<string, FolderState>();
  private engineState: Engine | undefined;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  get engine(): Engine | undefined {
    return this.engineState;
  }

  setEngine(engine: Engine): void {
    this.engineState = engine;
    this.changed.fire();
  }

  states(): FolderState[] {
    return [...this.folders.values()];
  }

  get(folder: vscode.WorkspaceFolder): FolderState {
    const key = folder.uri.toString();
    let state = this.folders.get(key);
    if (!state) {
      state = { folder, scanning: false, last: undefined };
      this.folders.set(key, state);
    }
    return state;
  }

  setScanning(folder: vscode.WorkspaceFolder, scanning: boolean): void {
    this.get(folder).scanning = scanning;
    this.changed.fire();
  }

  setOutcome(folder: vscode.WorkspaceFolder, outcome: Settled): void {
    const state = this.get(folder);
    state.last = outcome;
    state.scanning = false;
    this.changed.fire();
  }

  remove(folder: vscode.WorkspaceFolder): void {
    this.folders.delete(folder.uri.toString());
    this.changed.fire();
  }

  /** The strongest verdict across every scanned folder, or undefined before any scan settles. */
  overall(): FolderVerdict | undefined {
    let verdict: FolderVerdict | undefined;
    for (const state of this.folders.values()) {
      if (state.last) {
        verdict = verdict ? strongest(verdict, state.last.verdict) : state.last.verdict;
      }
    }
    return verdict;
  }

  dispose(): void {
    this.changed.dispose();
  }
}
