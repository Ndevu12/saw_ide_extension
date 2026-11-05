import * as vscode from "vscode";

import { pageDocument } from "../../core/chat/brand";
import { answerLine, decisionLine, type AskDecision, type AskQuestion } from "../../core/fix/ask";
import { plain } from "../../core/text";
import { openAsk, openIntroduced, openSupply, openTakeOut, registerAskDocuments } from "./askDiff";
import type { Model } from "../model";

type Step = "ask" | "supply" | "confirm";

const escape = (value: string, limit = 400): string =>
  plain(value, limit).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);

const DECIDE_SCRIPT = `
  const vscode = acquireVsCodeApi();
  const chosenNow = () => [...document.querySelectorAll("input[type=checkbox]:checked")].map((item) => item.value);
  document.body.addEventListener("change", (event) => {
    const box = event.target;
    if (box instanceof HTMLInputElement && box.type === "checkbox") vscode.postMessage({ act: "choose", chosen: chosenNow() });
  });
  document.body.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-act]") : null;
    if (!button) return;
    vscode.postMessage({ act: button.getAttribute("data-act"), chosen: chosenNow() });
  });
`;

/**
 * The Decide view: one question from `saw fix --ask=jsonl`, answered with the same actions the
 * diff toolbar offers. Closing the view does not answer. Stopping the fix does not answer.
 */
export class Decide implements vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private tab: vscode.WebviewPanel | undefined;
  private folder: vscode.WorkspaceFolder | undefined;
  private question: AskQuestion | undefined;
  private step: Step = "ask";
  private chosen: string[] = [];
  private supplyPath: string | undefined;
  private hint = "";
  private readonly log: string[] = [];
  /** The question id of the last answer sent. Saw repeats that id when it does not accept the answer. */
  private answeredId: string | undefined;
  private pending: ((decision: AskDecision | "stop") => void) | undefined;
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly model: Model,
    private readonly output: vscode.LogOutputChannel,
  ) {
    this.subscriptions = [
      registerAskDocuments(),
      vscode.window.registerWebviewViewProvider("saw.decide", {
        resolveWebviewView: (view) => {
          this.view = view;
          view.webview.options = { enableScripts: true };
          view.onDidDispose(() => {
            if (this.view === view) {
              this.view = undefined;
            }
          });
          view.webview.onDidReceiveMessage((message: { act?: string; chosen?: unknown }) => {
            void this.onAct(message.act, Array.isArray(message.chosen) ? message.chosen.filter((item): item is string => typeof item === "string") : []);
          });
          this.render();
        },
      }),
      vscode.commands.registerCommand("saw.decideShow", () => this.show()),
      vscode.commands.registerCommand("saw.decideKeep", () => this.finish({ action: "keep" })),
      vscode.commands.registerCommand("saw.decideRemove", () => this.finish({ action: "remove" })),
      vscode.commands.registerCommand("saw.decideRestore", () => this.finish({ action: "restore" })),
      vscode.commands.registerCommand("saw.decideSupply", () => this.supply()),
      vscode.commands.registerCommand("saw.decideTakeOut", () => this.takeOut(this.chosen)),
      vscode.commands.registerCommand("saw.decideUseFile", () => {
        if (this.supplyPath) {
          this.finish({ action: "supply", path: this.supplyPath });
        }
      }),
      vscode.commands.registerCommand("saw.decideConfirmTakeOut", () => this.finish({ action: "take-out", chosen: this.chosen })),
    ];
  }

  lines(): readonly string[] {
    return this.log;
  }

  clearLog(): void {
    this.log.length = 0;
    this.answeredId = undefined;
    this.render();
  }

  /**
   * Drop the last logged choice when saw asks `id` again. That answer was not accepted, so the
   * report must not keep it. Returns whether a line was dropped.
   */
  repeated(id: string): boolean {
    if (this.answeredId !== id || !this.log.length) {
      return false;
    }
    this.log.pop();
    this.answeredId = undefined;
    return true;
  }

  /**
   * Which act the open question belongs to. A file question is amending history. A delivery or a
   * package question is fixing the checkout. Undefined when nothing is waiting.
   */
  waitingOn(): { folder: vscode.WorkspaceFolder; specialty: string } | undefined {
    if (!this.folder || !this.question) {
      return undefined;
    }
    const specialty = this.question.kind === "file"
      ? "This question is about amending history. The answer can rewrite the commits that carried this file. Fixing the checkout does not ask it."
      : this.question.kind === "package"
        ? "This question is part of fixing the checkout. It decides whether a known-malicious package stays declared. It does not rewrite past commits."
        : "This question is part of fixing the checkout. It decides which files added beside the malicious code stay. It does not rewrite past commits.";
    return { folder: this.folder, specialty };
  }

  /** Wait until the operator answers `question`, or the fix is stopped. */
  async ask(folder: vscode.WorkspaceFolder, question: AskQuestion): Promise<AskDecision | "stop"> {
    this.folder = folder;
    this.question = question;
    this.step = "ask";
    this.chosen = [];
    this.supplyPath = undefined;
    this.hint = "";
    this.model.setDeciding(folder, true);
    this.contexts();
    this.render();
    this.output.info(`${folder.name}: saw is waiting on a ${question.kind}.`);
    await vscode.commands.executeCommand("saw.decide.focus");
    this.render();
    await openAsk(folder, question);
    this.reveal();
    return new Promise((resolve) => {
      this.pending = resolve;
    });
  }

  /** The fix ended or was stopped. An open question is not answered. */
  cancel(): void {
    this.settle("stop");
  }

  show(): void {
    if (this.question && this.folder) {
      void this.reopen();
    }
    this.reveal();
  }

  dispose(): void {
    this.cancel();
    this.tab?.dispose();
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }

  /** The question, as an editor tab beside the diff. Chat is what opens it. */
  private reveal(): void {
    if (this.tab) {
      this.tab.reveal(vscode.ViewColumn.Beside);
      this.render();
      return;
    }
    const panel = vscode.window.createWebviewPanel("saw.decideTab", this.tabTitle(), vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
    this.tab = panel;
    const messages = panel.webview.onDidReceiveMessage((message: { act?: string; chosen?: unknown }) => {
      void this.onAct(message.act, Array.isArray(message.chosen) ? message.chosen.filter((item): item is string => typeof item === "string") : []);
    });
    const gone = panel.onDidDispose(() => {
      messages.dispose();
      gone.dispose();
      if (this.tab === panel) {
        this.tab = undefined;
      }
    });
    this.render();
  }

  private tabTitle(): string {
    return this.folder ? `Decide · ${this.folder.name}` : "Decide";
  }

  private async reopen(): Promise<void> {
    if (!this.folder || !this.question) {
      return;
    }
    if (this.step === "confirm" && this.question.kind === "delivery") {
      await openTakeOut(this.folder, this.question.commit, this.chosen);
      return;
    }
    if (this.step === "supply" && this.question.kind === "file" && this.supplyPath) {
      await openSupply(this.folder, this.question, this.supplyPath);
      return;
    }
    await openAsk(this.folder, this.question);
  }

  private contexts(): void {
    const question = this.question;
    void vscode.commands.executeCommand("setContext", "saw.deciding", question !== undefined);
    void vscode.commands.executeCommand("setContext", "saw.decideKind", question?.kind ?? "");
    void vscode.commands.executeCommand("setContext", "saw.decideStep", question ? this.step : "");
    void vscode.commands.executeCommand("setContext", "saw.decideCanRestore", question?.kind === "file" && question.restore !== undefined);
    void vscode.commands.executeCommand("setContext", "saw.decideCanSupply", question?.kind === "file" && question.supply);
  }

  private async onAct(act: string | undefined, chosen: string[]): Promise<void> {
    if (!this.question || !this.folder) {
      return;
    }
    if (act === "keep") {
      this.finish({ action: "keep" });
      return;
    }
    if (act === "remove") {
      this.finish({ action: "remove" });
      return;
    }
    if (act === "restore") {
      this.finish({ action: "restore" });
      return;
    }
    if (act === "supply") {
      await this.supply();
      return;
    }
    if (act === "choose") {
      this.remember(chosen);
      return;
    }
    if (act === "take-out") {
      this.takeOut(chosen);
      return;
    }
    if (act === "use-file") {
      if (this.supplyPath) {
        this.finish({ action: "supply", path: this.supplyPath });
      }
      return;
    }
    if (act === "confirm-take-out") {
      this.finish({ action: "take-out", chosen: this.chosen });
      return;
    }
    if (act === "back") {
      this.step = "ask";
      this.hint = "";
      this.contexts();
      this.render();
      await openAsk(this.folder, this.question);
      return;
    }
    if (act === "show") {
      await this.reopen();
      return;
    }
    if (act === "introduced" && this.question.kind === "file") {
      const opened = await openIntroduced(this.folder, this.question);
      if (!opened) {
        this.hint = "git could not read that commit.";
        this.render();
      }
    }
  }

  private async supply(): Promise<void> {
    if (this.question?.kind !== "file" || !this.question.supply || !this.folder) {
      return;
    }
    const picked = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectMany: false, openLabel: "Supply this file" });
    const file = picked?.[0];
    if (!file || !this.question) {
      return;
    }
    this.supplyPath = file.fsPath;
    this.step = "supply";
    this.hint = "";
    this.contexts();
    this.render();
    await openSupply(this.folder, this.question, file.fsPath);
  }

  private remember(chosen: string[]): void {
    if (this.question?.kind !== "delivery") {
      return;
    }
    const offered = new Set(this.question.files.map((file) => file.path));
    this.chosen = chosen.filter((item) => offered.has(item));
  }

  private takeOut(chosen: string[]): void {
    if (this.question?.kind !== "delivery" || !this.folder) {
      return;
    }
    const offered = new Set(this.question.files.map((file) => file.path));
    this.chosen = chosen.filter((item) => offered.has(item));
    if (!this.chosen.length) {
      this.hint = "Select at least one file to take out.";
      this.render();
      return;
    }
    this.step = "confirm";
    this.hint = "";
    this.contexts();
    this.render();
    void openTakeOut(this.folder, this.question.commit, this.chosen);
  }

  private finish(decision: AskDecision): void {
    if (!this.question || !answerLine(this.question, decision)) {
      this.hint = "That is not an answer to this question.";
      this.render();
      return;
    }
    this.answeredId = this.question.id;
    this.log.push(decisionLine(this.question, decision));
    this.settle(decision);
  }

  private settle(result: AskDecision | "stop"): void {
    const pending = this.pending;
    if (!pending) {
      return;
    }
    this.pending = undefined;
    if (this.folder) {
      this.model.setDeciding(this.folder, false);
    }
    this.question = undefined;
    this.step = "ask";
    this.contexts();
    this.render();
    pending(result);
  }

  private render(): void {
    if (this.tab) {
      this.tab.title = this.tabTitle();
    }
    const body = this.question ? this.questionHtml() : this.idleHtml();
    if (this.view) {
      this.view.webview.html = pageDocument(Math.random().toString(36).slice(2), body, DECIDE_SCRIPT, "side");
    }
    if (this.tab) {
      this.tab.webview.html = pageDocument(Math.random().toString(36).slice(2), body, DECIDE_SCRIPT, "editor");
    }
  }

  private idleHtml(): string {
    const done = this.log.map((line) => `<li>${escape(line)}</li>`).join("");
    return `<p>When a fix needs a decision, it is made here. The diff opens beside it.</p>${done ? `<p class="meta">Last fix</p><ul>${done}</ul>` : ""}`;
  }

  private questionHtml(): string {
    const question = this.question;
    if (!question) {
      return "";
    }
    const hint = this.hint ? `<p class="hint">${escape(this.hint)}</p>` : "";
    const done = this.log.map((line) => `<li>${escape(line)}</li>`).join("");
    const history = done ? `<p class="meta">Already decided</p><ul>${done}</ul>` : "";
    return `${this.stepHtml(question)}${hint}<p class="actions"><button type="button" class="secondary" data-act="show">Show diff</button></p>${history}`;
  }

  private stepHtml(question: AskQuestion): string {
    if (this.step === "supply") {
      return `<p>Look at the diff, then use this file or choose another.</p>
        <p class="actions"><button type="button" class="primary" data-act="keep" autofocus>Keep</button>
        <button type="button" class="secondary" data-act="supply">Choose another</button>
        <button type="button" class="secondary" data-act="use-file">Use this file</button></p>`;
    }
    if (this.step === "confirm" && question.kind === "delivery") {
      const names = this.chosen.map((item) => `<li>${escape(item, 300)}</li>`).join("");
      return `<p>saw will take these files out of the prepared branch where it still has them as they were added.</p>
        <ul>${names}</ul>
        <p class="actions"><button type="button" class="primary" data-act="keep" autofocus>Keep them all</button>
        <button type="button" class="secondary" data-act="back">Back</button>
        <button type="button" class="danger" data-act="confirm-take-out">Take them out</button></p>`;
    }
    if (question.kind === "delivery") {
      const files = question.files
        .map((file) => {
          const named = file.namedBy === undefined ? "" : ` <span class="meta">named by ${file.namedBy}</span>`;
          const checked = this.chosen.includes(file.path) ? " checked" : "";
          return `<li><label><input type="checkbox" value="${escape(file.path, 300)}"${checked}> ${escape(file.path, 300)}</label>${named}</li>`;
        })
        .join("");
      const recorded = question.recorded ? `<p class="meta">saw asked about this commit before, then replaced it.</p>` : "";
      const known = question.knownAs.length ? `<p class="meta">Also known as ${escape(question.knownAs.map((id) => id.slice(0, 12)).join(", "), 300)}</p>` : "";
      return `<p>Files added in <strong>${escape(question.commit.slice(0, 12), 20)}</strong> ${escape(question.subject, 160)}</p>
        ${recorded}${known}
        <p class="meta">saw is already removing ${escape(question.removing.join(", ") || "the payload", 300)}</p>
        <ul>${files}</ul>
        <p class="actions"><button type="button" class="primary" data-act="keep" autofocus>Keep them all</button>
        <button type="button" class="danger" data-act="take-out">Take out selected</button></p>`;
    }
    if (question.kind === "package") {
      const files = question.manifests.map((manifest) => `<li>${escape(manifest.path, 300)}${manifest.proposed === undefined ? " <span class=\"meta\">saw will not rewrite this file</span>" : ""}</li>`).join("");
      return `<p><strong>${escape(question.name, 200)}</strong> ${escape(question.versions.join(", "), 200)} is a known-malicious package.</p>
        <ul>${files}</ul>
        <p class="actions"><button type="button" class="primary" data-act="keep" autofocus>Leave it declared</button>
        <button type="button" class="danger" data-act="confirm-take-out">Take it out</button></p>`;
    }
    const title = question.confirmed ? "saw confirmed this file and could not clean it" : "saw is unsure about this file";
    const origin = question.originUnread
      ? "git could not read what this file arrived with"
      : question.introducedBy
        ? `<button type="button" class="secondary" data-act="introduced">Introduced in ${escape(question.introducedBy.slice(0, 12), 20)}</button>`
        : "no commit ties it to the payload";
    const withRemoved = question.arrivedWithRemoved.length ? `<p class="meta">saw is already removing ${escape(question.arrivedWithRemoved.join(", "), 300)}</p>` : "";
    const restore = question.restore ? `<button type="button" class="secondary" data-act="restore">Restore</button>` : "";
    const supply = question.supply ? `<button type="button" class="secondary" data-act="supply">Supply a file</button>` : "";
    return `<p>${escape(title)}. <strong>${escape(question.path, 300)}</strong></p>
      <p class="meta">${escape(question.category, 80)} ${escape(question.signatureId, 80)} ${escape(question.description, 400)}</p>
      <p class="meta">${question.introducedBy && !question.originUnread ? origin : escape(origin, 200)}</p>${withRemoved}
      <p class="actions"><button type="button" class="primary" data-act="keep" autofocus>Keep</button>
      <button type="button" class="danger" data-act="remove">Remove</button>${restore}${supply}</p>`;
  }
}
