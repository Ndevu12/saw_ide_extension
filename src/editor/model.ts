import * as vscode from "vscode";

import type { AuditDetails, AuditVerdict, HookStatus } from "../core/fix/actions";
import type { ScanOutcome } from "../core/scan/scan";
import { strongest, type FolderVerdict } from "../core/scan/verdict";
import type { Engine } from "./install/engine";

export type Settled = Exclude<ScanOutcome, { kind: "cancelled" }>;

export interface FolderState {
  folder: vscode.WorkspaceFolder;
  scanning: boolean;
  fixing: boolean;
  /** A fix is waiting on a decision in the Decide view. */
  deciding: boolean;
  /** What saw says it is doing, while it scans; from a saw with `--progress=jsonl`. */
  progress: string | undefined;
  last: Settled | undefined;
}

export interface AuditRecord {
  verdict: AuditVerdict;
  /** saw's own rotation-safety sentence, when the report had one. */
  sentence: string | undefined;
  /** What `saw audit --json` said beyond the verdict, from a saw that has it. */
  details?: AuditDetails | undefined;
  at: number;
}

/** What saw last said about this machine rather than a folder. */
export interface MachineState {
  auditing: boolean;
  /** What saw says it is doing, while it audits. */
  auditProgress: string | undefined;
  audit: AuditRecord | undefined;
  hooks: HookStatus | undefined;
}

/** What every view shows: the engine's state and each folder's latest scan. */
export class Model implements vscode.Disposable {
  private readonly folders = new Map<string, FolderState>();
  private engineState: Engine | undefined;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  readonly machine: MachineState = { auditing: false, auditProgress: undefined, audit: undefined, hooks: undefined };

  get engine(): Engine | undefined {
    return this.engineState;
  }

  setMachine(change: Partial<MachineState>): void {
    Object.assign(this.machine, change);
    this.changed.fire();
  }

  setFixing(folder: vscode.WorkspaceFolder, fixing: boolean): void {
    const state = this.get(folder);
    state.fixing = fixing;
    if (!fixing) {
      state.deciding = false;
    }
    this.changed.fire();
  }

  setDeciding(folder: vscode.WorkspaceFolder, deciding: boolean): void {
    const state = this.get(folder);
    if (state.deciding === deciding) {
      return;
    }
    state.deciding = deciding;
    this.changed.fire();
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
      state = { folder, scanning: false, fixing: false, deciding: false, progress: undefined, last: undefined };
      this.folders.set(key, state);
    }
    return state;
  }

  setScanning(folder: vscode.WorkspaceFolder, scanning: boolean): void {
    const state = this.get(folder);
    state.scanning = scanning;
    state.progress = undefined;
    this.changed.fire();
  }

  setProgress(folder: vscode.WorkspaceFolder, progress: string | undefined): void {
    const state = this.get(folder);
    if (state.scanning && state.progress !== progress) {
      state.progress = progress;
      this.changed.fire();
    }
  }

  setOutcome(folder: vscode.WorkspaceFolder, outcome: Settled): void {
    const state = this.get(folder);
    state.last = outcome;
    state.scanning = false;
    state.progress = undefined;
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
