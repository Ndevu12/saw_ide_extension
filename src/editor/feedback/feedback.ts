import * as vscode from "vscode";

import type { ChatCard } from "../../core/chat/transcript";
import {
  askBlocked,
  askKind,
  dismissAsk,
  feedbackCard,
  issueUrl,
  noteHold,
  noteScan,
  readMemory,
  reviewUrl,
  showAsk,
  starUrl,
  supportAsk,
  type FeedbackFacts,
  type FeedbackMemory,
} from "../../core/feedback/ask";
import { strongest, type FolderVerdict } from "../../core/scan/verdict";
import type { Model } from "../model";

const KEY = "feedback.ask";

/**
 * Shows the rating card after a hold or three quiet scans, and opens the rating, star, and
 * issue pages. A dismissal lasts for this extension version.
 */
export class Feedback implements vscode.Disposable {
  private memory: FeedbackMemory;
  private forced = false;
  private choosing = false;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly subscriptions: vscode.Disposable[] = [this.changed];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly model: Model,
  ) {
    this.memory = readMemory(context.globalState.get(KEY));
    this.subscriptions.push(model.onDidChange(() => this.pull()));
    this.pull();
  }

  /** The card, when it should be on screen. The command forces it open. */
  card(): ChatCard | undefined {
    const blocked = askBlocked(this.model.states().map((state) => ({
      ...(state.last ? { verdict: state.last.verdict } : {}),
      checking: state.checking,
      scanning: state.scanning,
      deciding: state.deciding,
      fixing: state.fixing,
    })));
    if (!this.forced && !showAsk(this.memory, this.version(), blocked)) {
      return undefined;
    }
    return feedbackCard(askKind(this.memory), this.choosing);
  }

  /** Open the card from the command. */
  open(): void {
    this.forced = true;
    this.choosing = false;
    this.changed.fire();
  }

  act(name: string | undefined): void {
    switch (name) {
      case "rate":
        this.memory = supportAsk(this.memory);
        this.close();
        void this.openExternal(reviewUrl(vscode.env.appName));
        return;
      case "star":
        this.memory = supportAsk(this.memory);
        this.close();
        void this.openExternal(starUrl());
        return;
      case "report":
        this.choosing = true;
        this.changed.fire();
        return;
      case "request":
        this.hideForThisVersion();
        void this.openExternal(issueUrl("extension", "feature", this.facts()));
        return;
      case "editor":
        this.hideForThisVersion();
        void this.openExternal(issueUrl("extension", "problem", this.facts()));
        return;
      case "found":
        this.hideForThisVersion();
        void this.openExternal(issueUrl("saw", "problem", this.facts()));
        return;
      case "back":
        this.choosing = false;
        this.changed.fire();
        return;
      case "dismiss":
        this.memory = dismissAsk(this.memory, this.version());
        this.close();
        return;
      default:
        return;
    }
  }

  private close(): void {
    this.forced = false;
    this.choosing = false;
    this.persist();
    this.changed.fire();
  }

  /** A report or a request hides the ask for this version. The command can open it again. */
  private hideForThisVersion(): void {
    this.memory = dismissAsk(this.memory, this.version());
    this.close();
  }

  private pull(): void {
    let next = this.memory;
    for (const state of this.model.states()) {
      const folder = state.folder.uri.toString();
      const last = state.last;
      if (last?.kind === "scanned") {
        next = noteScan(next, folder, last.payload.generatedAt, last.verdict);
      }
      if (state.held && !state.held.released) {
        next = noteHold(next, `${folder}:${state.held.at}`);
      }
    }
    if (next === this.memory) {
      return;
    }
    this.memory = next;
    this.persist();
    this.changed.fire();
  }

  private facts(): FeedbackFacts {
    const engine = this.model.engine;
    let verdict: FolderVerdict | undefined;
    for (const state of this.model.states()) {
      if (state.last) {
        verdict = verdict ? strongest(verdict, state.last.verdict) : state.last.verdict;
      }
    }
    return {
      extensionVersion: this.version(),
      sawVersion: engine?.kind === "ready" ? engine.version : "not running",
      editor: vscode.env.appName,
      verdict: verdict ?? "none",
    };
  }

  private version(): string {
    const version = (this.context.extension.packageJSON as { version?: string }).version;
    return typeof version === "string" && version !== "" ? version : "0";
  }

  private persist(): void {
    void this.context.globalState.update(KEY, this.memory);
  }

  private openExternal(target: string): void {
    void vscode.env.openExternal(vscode.Uri.parse(target));
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }
}
