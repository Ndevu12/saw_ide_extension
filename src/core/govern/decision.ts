import * as path from "node:path";

import type { FolderVerdict } from "../scan/verdict";

// What the operator decides about an update saw could not check, or checked and held: run the
// command as typed and scan the folder after, or leave the folder as it is.

export type Decision = "run-as-typed" | "leave-unchanged";

/** saw's own name for deciding ahead, so one setting covers saw's stand-in and this one. */
export const DECISION_ENV = "SAW_GOVERN_DECISION";

/** How long the stand-in waits for the editor's answer before it leaves the folder unchanged. */
export const ASK_EDITOR_MS = 120_000;

export function decisionFromEnv(env: NodeJS.ProcessEnv): Decision | undefined {
  const value = env[DECISION_ENV]?.trim();
  return value === "run-as-typed" || value === "leave-unchanged" ? value : undefined;
}

/** Only an explicit yes runs the command. */
export function terminalAnswer(line: string): Decision {
  return /^\s*y(es)?\s*$/i.test(line) ? "run-as-typed" : "leave-unchanged";
}

export function commandText(tool: string, args: readonly string[]): string {
  return [tool, ...args].join(" ");
}

export function terminalQuestion(tool: string, args: readonly string[], reason: string): string {
  return `saw cannot check this update: ${reason}.\nRun \`${commandText(tool, args)}\` as typed anyway? The folder is scanned straight after. [y/N] `;
}

/** Letting in an infected update takes typing the folder's name, so it is never one keypress. */
export function heldTerminalAnswer(line: string, verdict: FolderVerdict, repo: string): Decision {
  if (verdict === "infected") {
    return line.trim() === path.basename(repo) ? "run-as-typed" : "leave-unchanged";
  }
  return terminalAnswer(line);
}

export function heldTerminalQuestion(verdict: FolderVerdict, repo: string): string {
  return verdict === "infected"
    ? `To let this infected update in anyway, type the folder name (${path.basename(repo)}). Anything else leaves the folder unchanged: `
    : "Let it in anyway? The folder is scanned straight after. [y/N] ";
}

/** The question the stand-in leaves for the editor. `held` is set when saw checked the update and held it. */
export interface UpdateAsk {
  id: string;
  repo: string;
  tool: string;
  args: string[];
  reason: string;
  at: number;
  held?: FolderVerdict;
}

export function askFileName(id: string): string {
  return `${id}.ask.json`;
}

export function answerFileName(id: string): string {
  return `${id}.answer`;
}

export function readUpdateAsk(text: string): UpdateAsk | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const { id, repo, tool, args, reason, at, held } = record;
  if (typeof id !== "string" || !/^[a-z0-9-]+$/i.test(id) || typeof repo !== "string" || repo === "" || typeof tool !== "string"
    || !Array.isArray(args) || !args.every((arg) => typeof arg === "string") || typeof reason !== "string" || typeof at !== "number") {
    return undefined;
  }
  const heldVerdict = held === "suspicious" || held === "infected" || held === "incomplete" ? held : undefined;
  return { id, repo, tool, args: args as string[], reason, at, ...(heldVerdict ? { held: heldVerdict } : {}) };
}

export function readAnswer(text: string): Decision | undefined {
  const value = text.trim();
  return value === "run-as-typed" || value === "leave-unchanged" ? value : undefined;
}
