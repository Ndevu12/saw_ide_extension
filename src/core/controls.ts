import * as path from "node:path";

import type { FolderVerdict } from "./scan/verdict";

// What the extension decides for itself. A workspace or a folder setting is never one of these:
// the editor's merged value is not read.

/** `saw.*` keys. Each one is machine-scoped in package.json. */
export const SAW_KEYS = [
  "path",
  "autoInstall",
  "registerMcpServer",
  "guardAgentCommands",
  "governUpdates",
  "configPath",
  "scanOnStartup",
  "scanOnChange",
  "scanTimeoutSeconds",
] as const;

/** A project must not choose the git this window runs. */
export const PROJECT_GIT = "git.path";

/**
 * User settings put back while a folder is not in the clear. The previous user value is restored
 * when every open folder is.
 */
export const STRICT_SETTINGS = [
  { key: "security.workspace.trust.untrustedFiles", value: "newWindow" },
  { key: "extensions.ignoreRecommendations", value: true },
  { key: "task.autoDetect", value: "off" },
] as const;

/** The editor's own switch for tasks that run because a folder opened. Held off; the extension asks first. */
export const AUTOMATIC_TASKS = "task.allowAutomaticTasks";

export interface SettingLayer<T> {
  globalValue?: T;
  defaultValue?: T;
}

/** The machine value, then the registered default, then `fallback`. A workspace value is not here. */
export function owned<T>(layer: SettingLayer<T> | undefined, fallback: T, accept: (value: unknown) => value is T): T {
  if (layer && accept(layer.globalValue)) {
    return layer.globalValue;
  }
  if (layer && accept(layer.defaultValue)) {
    return layer.defaultValue;
  }
  return fallback;
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** One scan's time budget. A non-number, or a number under five seconds, uses the floor. */
export function timeoutMs(seconds: unknown): number {
  const value = isNumber(seconds) ? seconds : 120;
  return Math.max(5, value) * 1000;
}

function contained(folder: string, target: string): boolean {
  const relative = path.relative(path.resolve(folder), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * A saw config the extension may pass. Empty when it is unset or sits inside an open folder:
 * that file is the project's, and it does not get to allow what saw reports.
 */
export function configOutsideFolders(configPath: string, folders: readonly string[]): string {
  const trimmed = configPath.trim();
  if (!trimmed) {
    return "";
  }
  return folders.some((folder) => contained(folder, trimmed)) ? "" : trimmed;
}

export interface StrictFolder {
  verdict?: FolderVerdict;
  unheld: boolean;
  held: boolean;
}

/** True when an open folder is suspicious or infected, a change was not held, or an update is held. */
export function needsStrict(folders: readonly StrictFolder[]): boolean {
  return folders.some((folder) => folder.unheld || folder.held || folder.verdict === "infected" || folder.verdict === "suspicious");
}
