import { createHash } from "node:crypto";
import * as path from "node:path";

import type { FolderVerdict } from "../scan/verdict";

// The Cursor agent guard: a `beforeShellExecution` hook that checks a folder's saw verdict before
// the agent runs a command that installs or runs that folder's code. The extension writes one
// record per folder and window; the hook reads them and decides.

/** Programs that install or run a project's code: package managers, build tools and interpreters. */
const RUNNERS = [
  "npm", "npx", "pnpm", "pnpx", "yarn", "bun", "bunx", "deno", "node", "corepack", "tsx", "ts-node",
  "pip", "pip3", "python", "python3", "uv", "uvx", "poetry", "pdm", "hatch", "pipenv", "tox", "nox", "pytest",
  "make", "cmake", "ninja", "cargo", "go", "gradle", "gradlew", "mvn", "mvnw", "ant",
  "bundle", "rake", "ruby", "gem", "composer", "php", "dotnet", "mix", "just", "task", "turbo", "nx", "lerna",
  "docker", "podman", "sh", "bash", "zsh",
];

/** git commands that run the repository's own hooks. */
const GIT_RUNS_HOOKS = ["commit", "checkout", "switch", "pull", "merge", "rebase", "push", "am", "cherry-pick", "submodule"];

// A command position: the start, after a separator, or after a prefix such as `sudo` or `env`,
// followed by any `NAME=value` assignments.
const AT_COMMAND = String.raw`(?:^|[;&|(\x60]|\b(?:sudo|env|exec|time|nohup|xargs|then|do|else)\s)\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*`;
const END = String.raw`(?=$|[\s;&|)])`;

/** Cursor's hook matcher, a regular expression tested against the whole command. */
export const GUARDED_COMMAND = [
  `${AT_COMMAND}(?:\\S*/)?(?:${RUNNERS.join("|")})${END}`,
  `${AT_COMMAND}\\.{1,2}/\\S`,
  `${AT_COMMAND}(?:\\S*/)?git\\s+(?:-\\S+\\s+(?:[^-\\s]\\S*\\s+)?)*(?:${GIT_RUNS_HOOKS.join("|")})${END}`,
].join("|");

const guarded = new RegExp(GUARDED_COMMAND);

export function isGuarded(command: string): boolean {
  return guarded.test(command);
}

/** What the extension last knew about one folder, in one window. */
export interface GuardRecord {
  path: string;
  name: string;
  /** Undefined while saw has no verdict for the latest change, or cannot run. */
  verdict: FolderVerdict | undefined;
  /** What the agent is told: saw's verdict and guidance, with nothing quoted from scanned files. */
  report: string;
  updatedAt: number;
}

/** The record file for a folder in one window; the hook reads every window's and takes the newest. */
export function recordName(folderPath: string, window: string): string {
  return `${folderKey(folderPath)}-${window.replace(/[^A-Za-z0-9]/g, "").slice(0, 40)}.json`;
}

export function folderKey(folderPath: string): string {
  return createHash("sha256").update(path.resolve(folderPath)).digest("hex").slice(0, 32);
}

export interface HookInput {
  command?: unknown;
  cwd?: unknown;
  workspace_roots?: unknown;
}

export interface HookAnswer {
  permission: "allow" | "deny" | "ask";
  user_message?: string;
  agent_message?: string;
}

function inside(folder: string, target: string): boolean {
  const relative = path.relative(path.resolve(folder), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** The workspace folder a command runs in: the innermost root holding its directory. */
export function folderOf(input: HookInput): string | undefined {
  const roots = Array.isArray(input.workspace_roots) ? input.workspace_roots.filter((r): r is string => typeof r === "string" && r !== "") : [];
  const cwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : roots.length === 1 ? roots[0] : undefined;
  if (!cwd) {
    return undefined;
  }
  return roots.filter((root) => inside(root, cwd)).sort((a, b) => b.length - a.length)[0];
}

/** The hook's answer, from the newest record for the folder the command runs in. */
export function decide(input: HookInput, record: GuardRecord | undefined): HookAnswer {
  const command = typeof input.command === "string" ? input.command : "";
  if (!isGuarded(command) || !record) {
    return { permission: "allow" };
  }
  const name = record.name;
  switch (record.verdict) {
    case "clean":
    case "residue":
      return { permission: "allow" };
    case "infected":
      return {
        permission: "deny",
        user_message: `saw stopped this command: it found ${name} infected, and the command could run the worm. Review saw's findings in the saw view.`,
        agent_message: record.report,
      };
    case "suspicious":
      return { permission: "ask", user_message: `saw found something suspicious in ${name}. Run this command anyway?`, agent_message: record.report };
    case "incomplete":
      return { permission: "ask", user_message: `saw could not finish checking ${name}. Run this command anyway?`, agent_message: record.report };
    default:
      return { permission: "ask", user_message: `saw has not checked the latest changes in ${name} yet. Run this command anyway?`, agent_message: record.report };
  }
}

/** When the hook cannot read what saw knows, the person decides. */
export const UNREADABLE: HookAnswer = {
  permission: "ask",
  user_message: "saw could not check this folder's verdict before the command. Run it anyway?",
  agent_message: "saw could not check this folder's verdict, so it is not known to be safe. Tell the person before installing, running or building anything.",
};

/** The hook configuration Cursor reads from the plugin's `hooks/hooks.json`. */
export function hooksJson(command: string): string {
  return JSON.stringify({ version: 1, hooks: { beforeShellExecution: [{ command, matcher: GUARDED_COMMAND, timeout: 10 }] } }, null, 2);
}

/** A POSIX shell word for one argument. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
