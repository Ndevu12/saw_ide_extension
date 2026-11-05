import * as path from "node:path";

import { plain } from "./text";

// What may start because a folder or a file was opened. The editor asks before any of these run.

/** A task JSON `runOptions.runOn` of `folderOpen`. Anything else was started by a person. */
export function isFolderOpenRun(runOn: unknown): boolean {
  return runOn === "folderOpen";
}

/** Identity of one open-time command. A changed command is a different question. */
export function openRunKey(folder: string, source: string, name: string, command: string): string {
  return [folder, source, name, command].join("\0");
}

/** The question for a task the folder set to run on open. The command text is plain. */
export function openRunQuestion(name: string, command: string): string {
  const shown = plain(name, 160) || "a task";
  const line = plain(command, 240);
  const what = line ? `${shown} — ${line}` : shown;
  return `This folder wants to run ${what} because it opened. Run it?`;
}

export function heldQuestion(name: string, command: string): string {
  const shown = plain(name, 160) || "a task";
  const line = plain(command, 240);
  const what = line ? `${shown} — ${line}` : shown;
  return `This folder wants to run ${what} because it opened. Restricted Mode is holding it.`;
}

/** The question for a shell whose program or arguments sit inside the folder. */
export function shellQuestion(shellPath: string, args: readonly string[]): string {
  const line = plain([shellPath, ...args].filter(Boolean).join(" "), 240) || "a program in this folder";
  return `A terminal wants to start with ${line} from this folder. Start it?`;
}

export function shellHeldQuestion(shellPath: string, args: readonly string[]): string {
  const line = plain([shellPath, ...args].filter(Boolean).join(" "), 240) || "a program in this folder";
  return `A terminal wants to start with ${line} from this folder. Restricted Mode is holding it.`;
}

function looksLikePath(value: string): boolean {
  return path.isAbsolute(value) || value.startsWith(".") || value.includes("/") || value.includes("\\");
}

function inside(folder: string, target: string): boolean {
  const relative = path.relative(path.resolve(folder), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * True when the shell program, or one of its arguments, is a path inside an open folder.
 * A bare program name and the folder used only as the working directory are not.
 */
export function shellUsesFolder(shellPath: string, args: readonly string[], folders: readonly string[]): boolean {
  return [shellPath, ...args].some((part) => {
    const token = part.trim();
    return token !== "" && looksLikePath(token) && folders.some((folder) => inside(folder, token));
  });
}

/** Text for a setting value named in a question. */
export function settingSummary(value: unknown): string {
  if (typeof value === "string") {
    return plain(value, 240);
  }
  return plain(JSON.stringify(value) ?? "", 240);
}

export function terminalSettingQuestion(summary: string): string {
  const shown = summary || "a shell from this folder";
  return `This folder wants the terminal to start with ${shown}. Allow it?`;
}
