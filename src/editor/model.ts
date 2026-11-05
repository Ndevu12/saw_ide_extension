import * as vscode from "vscode";

import type { AuditDetails, AuditVerdict, HookStatus } from "../core/fix/actions";
import type { ScanOutcome } from "../core/scan/scan";
import { strongest, type FolderVerdict } from "../core/scan/verdict";
import type { Engine } from "./install/engine";

/** An update that was checked before it was allowed to change the folder. */
export interface HeldUpdate {
  verdict: FolderVerdict;
  reasons: string[];
  released: boolean;
  at: number;
}

export type Settled = Exclude<ScanOutcome, { kind: "cancelled" }>;

export interface FolderState {
  folder: vscode.WorkspaceFolder;
  scanning: boolean;
  fixing: boolean;
  /** A fix is waiting on a decision in the Decide view. */
  deciding: boolean;
  /** What saw says it is doing, while it scans; from a saw with `--progress=jsonl`. */
  progress: string | undefined;
  /** Set while an incoming update, or the open folder, is being checked and has not changed. */
  checking: boolean;
  /** The step saw named during that check, when it named one. */
  checkStep: string | undefined;
  /** An update landing, or the tree already open. The words differ. */
  checkAbout: "update" | "admission" | undefined;
  /** A git command this window did not run changed the folder, or the open folder is not a commit saw let in. */
  unheld: boolean;
  /** Which of those two the line should name. Unset when nothing is unheld. */
  unheldFrom: "command" | "open" | undefined;
  /** Set while an incoming update is held. Cleared once that update is applied. */
  held: HeldUpdate | undefined;
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
  /** `saw watch status` is being read. */
  readingWatch: boolean;
  /** The first line of the last watch report this window read. */
  watch: { line: string; at: number } | undefined;
}

/** What every view shows: the engine's state and each folder's latest scan. */
export class Model implements vscode.Disposable {
  private readonly folders = new Map<string, FolderState>();
  private engineState: Engine | undefined;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  readonly machine: MachineState = { auditing: false, auditProgress: undefined, audit: undefined, hooks: undefined, readingWatch: false, watch: undefined };

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
      state = { folder, scanning: false, fixing: false, deciding: false, progress: undefined, checking: false, checkStep: undefined, checkAbout: undefined, unheld: false, unheldFrom: undefined, held: undefined, last: undefined };
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

  setChecking(folder: vscode.WorkspaceFolder, step: string | undefined, about: "update" | "admission" = "update"): void {
    const state = this.get(folder);
    if (state.checking && state.checkStep === step && state.checkAbout === about) {
      return;
    }
    state.checking = true;
    state.checkStep = step;
    state.checkAbout = about;
    state.unheld = false;
    state.unheldFrom = undefined;
    this.changed.fire();
  }

  clearChecking(folder: vscode.WorkspaceFolder): void {
    const state = this.get(folder);
    if (!state.checking && state.checkStep === undefined && state.checkAbout === undefined) {
      return;
    }
    state.checking = false;
    state.checkStep = undefined;
    state.checkAbout = undefined;
    this.changed.fire();
  }

  setUnheld(folder: vscode.WorkspaceFolder, unheld: boolean, from: "command" | "open" = "command"): void {
    const state = this.get(folder);
    const next = unheld ? from : undefined;
    if (state.unheld === unheld && state.unheldFrom === next) {
      return;
    }
    state.unheld = unheld;
    state.unheldFrom = next;
    this.changed.fire();
  }

  setHeld(folder: vscode.WorkspaceFolder, held: HeldUpdate | undefined): void {
    const state = this.get(folder);
    state.held = held;
    if (held) {
      state.unheld = false;
      state.unheldFrom = undefined;
    }
    this.changed.fire();
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
