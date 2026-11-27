import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import * as nodePath from "node:path";

import * as vscode from "vscode";

import { answerFileName, answerText, questionFileName, questionId, readQuestion, type CannotCheckQuestion, type HeldQuestion, type Question, type QuestionAnswer } from "../../core/govern/questions";
import type { FolderVerdict } from "../../core/scan/verdict";
import { VERDICT_LABEL } from "../present";

/** How long saw waits at most for an answer, so an older question is not asked. */
const LONGEST_WAIT_MS = 600_000;

/** Answers, with a dialog, what saw asks about git the editor runs with no terminal, such as a pull from the Git view. */
export class GitViewQuestions implements vscode.Disposable {
  private watcher: FSWatcher | undefined;
  private readonly asking = new Set<string>();

  constructor(
    readonly dir: string,
    private readonly heldVerdict: (folder: vscode.WorkspaceFolder) => FolderVerdict | undefined,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  /** Whether the folder is ready for saw's questions. */
  start(): boolean {
    if (this.watcher) {
      return true;
    }
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      chmodSync(this.dir, 0o700);
      this.watcher = watch(this.dir, () => this.read());
    } catch (error) {
      this.log.error(`saw cannot ask about git updates from the Git view: ${String(error)}`);
      return false;
    }
    this.read();
    return true;
  }

  private read(): void {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const id = questionId(name);
      if (!id || this.asking.has(id)) {
        continue;
      }
      const file = nodePath.join(this.dir, name);
      let question: Question | undefined;
      try {
        if (Date.now() - statSync(file).mtimeMs > LONGEST_WAIT_MS) {
          continue;
        }
        question = readQuestion(readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      const folder = question && vscode.workspace.getWorkspaceFolder(vscode.Uri.file(question.folder));
      if (!question || !folder) {
        continue;
      }
      this.asking.add(id);
      const asked = question;
      void this.ask(asked, folder).catch((error: unknown) => {
        this.log.error(`saw could not answer its question about ${folder.name}: ${String(error)}`);
      }).finally(() => this.asking.delete(asked.id));
    }
  }

  private async ask(question: Question, folder: vscode.WorkspaceFolder): Promise<void> {
    const answer = question.kind === "held" ? await this.askLetIn(question, folder) : await this.askRun(question, folder);
    const command = `\`${question.argv.join(" ")}\``;
    if (!existsSync(nodePath.join(this.dir, questionFileName(question.id)))) {
      this.log.info(`${folder.name}: saw stopped waiting for an answer about ${command} and left the folder unchanged.`);
      return;
    }
    this.answer(question, answer);
    const what = question.kind === "held" ? `saw held ${command}` : `saw could not check ${command}`;
    const done = answer === "leave-unchanged" ? "left unchanged" : answer === "let-in" ? "let in" : "run as typed";
    this.log.info(`${folder.name}: ${what}; ${done}.`);
  }

  private answer(question: Question, answer: QuestionAnswer): void {
    const temporary = nodePath.join(this.dir, `.${question.id}.${process.pid}.tmp`);
    writeFileSync(temporary, answerText(question, answer), { mode: 0o600 });
    try {
      linkSync(temporary, nodePath.join(this.dir, answerFileName(question.id)));
    } catch {
      // Another window answered first.
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  private async askRun(question: CannotCheckQuestion, folder: vscode.WorkspaceFolder): Promise<QuestionAnswer> {
    const run = "Run As Typed";
    const why = question.checked
      ? `saw checked this update to ${folder.name} but could not bring it into the folder: ${question.reason}.`
      : `saw cannot check this update to ${folder.name}: ${question.reason}.`;
    const picked = await vscode.window.showWarningMessage(
      why,
      { modal: true, detail: `Run \`${question.argv.join(" ")}\` as typed? The folder is scanned straight after. Otherwise the folder stays as it is.` },
      run,
      "Leave Unchanged",
    );
    return picked === run ? "run-as-typed" : "leave-unchanged";
  }

  /** The update's details open first, so the operator reads what was found before choosing. */
  private async askLetIn(question: HeldQuestion, folder: vscode.WorkspaceFolder): Promise<QuestionAnswer> {
    await vscode.commands.executeCommand("saw.openReport", { kind: "held", state: { folder } });
    const verdict = question.confirm ? "infected" : this.heldVerdict(folder) ?? "suspicious";
    const letIn = "Let In Anyway";
    const picked = await (question.confirm ? vscode.window.showErrorMessage : vscode.window.showWarningMessage)(
      `saw held this update to ${folder.name} (${VERDICT_LABEL[verdict]}).`,
      {
        modal: true,
        detail: question.confirm
          ? "What it would bring is infected, so it is safest to leave it. To work on it anyway, for example to fix it, let it in: you are asked to type the folder's name. saw scans the folder straight after."
          : `The details tab shows what saw found. Let \`${question.argv.join(" ")}\` in anyway? saw scans the folder straight after. Otherwise the folder stays as it is.`,
      },
      letIn,
      "Leave Unchanged",
    );
    if (picked !== letIn) {
      return "leave-unchanged";
    }
    if (!question.confirm) {
      return "let-in";
    }
    const expected = nodePath.basename(folder.uri.fsPath);
    const typed = await vscode.window.showInputBox({
      title: `Let an infected update into ${folder.name}`,
      prompt: `Type ${expected} to let it in. Nothing from it runs, but the files land in the folder.`,
      placeHolder: expected,
      ignoreFocusOut: true,
      validateInput: (value) => value === "" || value === expected ? undefined : `Type ${expected} exactly, or press Escape to leave the folder unchanged.`,
    });
    return typed === expected ? "let-in" : "leave-unchanged";
  }

  dispose(): void {
    this.watcher?.close();
  }
}
