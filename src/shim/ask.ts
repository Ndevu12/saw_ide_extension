import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";

import type { GovernConfig } from "../core/govern/contract";
import { answerFileName, ASK_EDITOR_MS, askFileName, decisionFromEnv, heldTerminalAnswer, heldTerminalQuestion, readAnswer, terminalAnswer, terminalQuestion, undecidedReason, type Decision, type UpdateAsk } from "../core/govern/decision";
import type { Hold } from "../core/govern/plan";
import type { FolderVerdict } from "../core/scan/verdict";

/** Stopped while waiting for a decision: nothing ran, so the folder is as it was. */
export function exitOnStop(cleanup: () => void): void {
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(name, () => {
      cleanup();
      process.exit(130);
    });
  }
}

/** Whether a person at this terminal can answer a question. */
export function terminalAnswers(): boolean {
  return process.stdin.isTTY === true && process.stderr.isTTY === true;
}

/** The operator's decision about an update saw could not check. With no one to ask, the folder is left as it is. */
export async function decide(config: GovernConfig, action: Hold, typed: readonly string[], reason: string, releasedButNotApplied?: FolderVerdict): Promise<Decision> {
  const ahead = decisionFromEnv(process.env);
  if (ahead) {
    process.stderr.write(`${undecidedReason(reason, releasedButNotApplied)}\n`);
    return ahead;
  }
  if (terminalAnswers()) {
    return askTerminal(terminalQuestion(action.tool, typed, reason, releasedButNotApplied), terminalAnswer);
  }
  const why = undecidedReason(reason, releasedButNotApplied);
  if (config.askDir) {
    const ask = { id: randomUUID(), repo: action.repo, tool: action.tool, args: [...typed], reason, at: Date.now(), ...(releasedButNotApplied ? { releasedButNotApplied } : {}) };
    return askEditor(config.askDir, ask, why, "The editor asks whether to run it as typed.");
  }
  process.stderr.write(`${why}\n`);
  return "leave-unchanged";
}

/**
 * Whether the operator lets in an update saw held for what it found. Deciding ahead with
 * SAW_GOVERN_DECISION does not count here: that is for updates saw could not check.
 */
export async function decideHeld(config: GovernConfig, action: Hold, typed: readonly string[], verdict: FolderVerdict, reason: string): Promise<boolean> {
  if (terminalAnswers()) {
    return (await askTerminal(heldTerminalQuestion(verdict, action.repo), (line) => heldTerminalAnswer(line, verdict, action.repo))) === "run-as-typed";
  }
  if (config.askDir) {
    const ask = { id: randomUUID(), repo: action.repo, tool: action.tool, args: [...typed], reason, at: Date.now(), held: verdict };
    return (await askEditor(config.askDir, ask, "", "The editor shows what was found and asks whether to let it in.")) === "run-as-typed";
  }
  return false;
}

export function askTerminal(question: string, read: (line: string) => Decision): Promise<Decision> {
  return new Promise((resolve) => {
    const lines = createInterface({ input: process.stdin, output: process.stderr });
    let answered = false;
    const answer = (decision: Decision) => {
      if (!answered) {
        answered = true;
        lines.close();
        resolve(decision);
      }
    };
    lines.on("SIGINT", () => {
      process.stderr.write("\n");
      answer("leave-unchanged");
    });
    exitOnStop(() => undefined);
    lines.on("close", () => answer("leave-unchanged"));
    lines.question(question, (line) => answer(read(line)));
  });
}

/** Leave the question for the editor, which shows it to the person, and wait for the answer. */
export async function askEditor(dir: string, ask: UpdateAsk, why: string, waiting: string): Promise<Decision> {
  const file = path.join(dir, askFileName(ask.id));
  const answerFile = path.join(dir, answerFileName(ask.id));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(ask));
    renameSync(`${file}.tmp`, file);
  } catch {
    if (why) {
      process.stderr.write(`${why}\n`);
    }
    return "leave-unchanged";
  }
  process.stderr.write(`${why ? `${why} ` : ""}${waiting}\n`);
  exitOnStop(() => {
    rmSync(file, { force: true });
    rmSync(answerFile, { force: true });
  });
  const end = Date.now() + ASK_EDITOR_MS;
  try {
    while (Date.now() < end) {
      let text: string | undefined;
      try {
        text = readFileSync(answerFile, "utf8");
      } catch {
        text = undefined;
      }
      const decision = text === undefined ? undefined : readAnswer(text);
      if (decision) {
        return decision;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    process.stderr.write("saw: no answer came from the editor.\n");
    return "leave-unchanged";
  } finally {
    rmSync(file, { force: true });
    rmSync(answerFile, { force: true });
  }
}
