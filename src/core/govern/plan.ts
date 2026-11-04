import { createHash } from "node:crypto";
import * as path from "node:path";

import { enclosingFolder, ghBringsFiles, gitBringsFiles, parseGit, type Tool } from "./command";
import type { GovernConfig } from "./contract";

export interface Hold {
  kind: "hold";
  tool: Tool;
  repo: string;
  holding: string;
  args: readonly string[];
}

export interface Passthrough {
  kind: "passthrough";
  program: string;
}

/** What the stand-in does with one command: run the real program, or ask saw to check it first. */
export function plan(config: GovernConfig, tool: Tool, args: readonly string[], cwd: string): Hold | Passthrough {
  const program = tool === "git" ? config.realGit : config.realGh;
  const through = (): Passthrough => ({ kind: "passthrough", program });
  if (!config.enabled || !config.saw || !program) {
    return through();
  }
  const target = tool === "git" ? gitTarget(args, cwd) : path.resolve(cwd);
  const brings = tool === "git" ? gitTargetBrings(args, cwd) : ghBringsFiles(args);
  const repo = target && brings ? enclosingFolder(config.folders, target) : undefined;
  if (!repo) {
    return through();
  }
  return { kind: "hold", tool, repo, holding: path.join(config.holdingRoot, folderKey(repo)), args };
}

function gitTarget(args: readonly string[], cwd: string): string | undefined {
  return parseGit(args, cwd)?.directory;
}

function gitTargetBrings(args: readonly string[], cwd: string): boolean {
  const command = parseGit(args, cwd);
  return command ? gitBringsFiles(command) : false;
}

export function folderKey(folderPath: string): string {
  return createHash("sha256").update(path.resolve(folderPath)).digest("hex").slice(0, 32);
}

/** saw's stand-in beside its own program, when that file is present. */
export function standinBeside(saw: string, isFile: (file: string) => boolean, name = "saw-git-standin"): string | undefined {
  if (!saw) {
    return undefined;
  }
  const candidate = path.join(path.dirname(saw), name);
  return isFile(candidate) ? candidate : undefined;
}

/** The folder `saw govern install` puts ahead of git and gh. `$XDG_CONFIG_HOME`, otherwise `~/.config`. */
export function systemGovernBin(xdg: string | undefined, home: string): string {
  const base = xdg ? xdg : path.join(home, ".config");
  return path.join(base, "saw", "govern", "bin");
}

/** Where saw writes one check record per open folder. `$XDG_STATE_HOME`, otherwise `~/.local/state`. */
export function governStatusDir(xdgState: string | undefined, home: string): string {
  const trimmed = xdgState?.trim();
  const base = trimmed ? trimmed : path.join(home, ".local", "state");
  return path.join(base, "saw", "govern", "status");
}

/** The environment that turns saw's stand-in on for one command. */
export function activationEnv(config: GovernConfig, tool: Tool, holding: string): Record<string, string> {
  return {
    SAW_GOVERN_HOLDING: holding,
    SAW_REAL_GIT: config.realGit,
    SAW_REAL_GH: config.realGh,
    SAW_BIN: config.saw,
    SAW_STANDIN_TOOL: tool,
  };
}

/** A POSIX stand-in. Missing config runs the real program, so a removed extension does not keep git. */
export function posixWrapper(node: string, shim: string, configPath: string, real: string, tool: Tool): string {
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  return [
    "#!/bin/sh",
    `if [ ! -f ${quote(configPath)} ]; then`,
    `  exec ${quote(real)} "$@"`,
    "fi",
    "export ELECTRON_RUN_AS_NODE=1",
    `exec ${quote(node)} ${quote(shim)} --config ${quote(configPath)} --tool ${tool} -- "$@"`,
    "",
  ].join("\n");
}

/** A Windows stand-in for the integrated terminal. The Git view is not pointed at a batch file. */
export function windowsWrapper(node: string, shim: string, configPath: string, real: string, tool: Tool): string {
  return [
    "@echo off",
    `if not exist "${configPath}" (`,
    `  "${real}" %*`,
    "  exit /b %ERRORLEVEL%",
    ")",
    "set ELECTRON_RUN_AS_NODE=1",
    `"${node}" "${shim}" --config "${configPath}" --tool ${tool} -- %*`,
    "",
  ].join("\r\n");
}
