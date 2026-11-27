import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:os";
import { readdirSync, readFileSync } from "node:fs";

import type { GovernConfig } from "../core/govern/contract";
import { activationEnv } from "../core/govern/plan";
import { diskFiles, pathWithoutStandins } from "../core/govern/realProgram";
import { enclosingFolder, parseGit, quietGit, repoConfigText, silencedRepoConfig, type Tool } from "../core/govern/command";

export function runPlaced(config: GovernConfig, tool: Tool, args: readonly string[], holding: string, onStderr: (text: string) => void, onExit: (code: number, spawnFailed: boolean) => void): void {
  const standin = config.standin;
  if (!standin) {
    onExit(1, true);
    return;
  }
  const guarded = guardGit(config, tool, args);
  const env: NodeJS.ProcessEnv = { ...guarded.env, ...activationEnv(config, tool, holding) };
  if (!config.realGit) {
    // No real git: saw's stand-in would look git up on PATH and find this stand-in. There is no git to check either.
    env["PATH"] = pathWithoutStandins(env["PATH"], config.standinDirs ?? [], diskFiles);
  }
  const child = spawn(standin, guarded.args, {
    stdio: ["inherit", "inherit", "pipe"],
    shell: false,
    env,
  });
  let failed = false;
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    process.stderr.write(text);
    onStderr(text);
  });
  child.on("error", () => {
    failed = true;
    onExit(127, true);
  });
  child.on("exit", (code, signal) => {
    if (failed) {
      return;
    }
    if (signal) {
      exitBySignal(signal);
      return;
    }
    onExit(code ?? 1, false);
  });
}

export function runRealOrExit(config: GovernConfig, tool: Tool, args: readonly string[], after?: () => void): void {
  const program = tool === "git" ? config.realGit : config.realGh;
  if (!program) {
    process.stderr.write(`saw could not find ${tool}.\n`);
    process.exit(127);
  }
  const guarded = guardGit(config, tool, args);
  runReal(program, guarded.args, guarded.env, after);
}

/** `alias.<name>` as the real git reads it for that repository, or undefined. */
export function aliasOf(config: GovernConfig): (name: string, directory: string) => string | undefined {
  return (name, directory) => {
    if (!config.realGit) {
      return undefined;
    }
    const read = spawnSync(config.realGit, ["-C", directory, "config", "--get", `alias.${name}`], { encoding: "utf8", timeout: 5000, shell: false });
    return read.status === 0 && read.stdout.trim() ? read.stdout.trim() : undefined;
  };
}


/** Git aimed at an open folder does not run that folder's fsmonitor, external diff, hooks, or other filters. */
export function guardGit(config: GovernConfig, tool: Tool, args: readonly string[]): { args: readonly string[]; env: NodeJS.ProcessEnv } {
  if (tool !== "git" || !config.quietHooks) {
    return { args, env: process.env };
  }
  const directory = parseGit(args, process.cwd(), process.env)?.directory ?? process.cwd();
  const repo = enclosingFolder(config.folders, directory);
  if (!repo) {
    return { args, env: process.env };
  }
  const text = repoConfigText(repo, (file) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  });
  return { args: quietGit(args, config.quietHooks, silencedRepoConfig(text)), env: withoutConfigInjection(process.env) };
}

export function injectsConfig(key: string): boolean {
  return key === "GIT_CONFIG" || key === "GIT_CONFIG_PARAMETERS" || key === "GIT_CONFIG_COUNT" || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key);
}

export function withoutConfigInjection(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !injectsConfig(key)));
}

/** How many entries a folder has, or undefined when it does not exist. */
export function entriesIn(dir: string): number | undefined {
  try {
    return readdirSync(dir).length;
  } catch {
    return undefined;
  }
}

/** Whether a clone left a checkout: a new folder, or files in a folder that was empty. */
export function landed(before: number | undefined, now: number | undefined): boolean {
  return now !== undefined && now > 0 && (before === undefined || before === 0);
}

export function runReal(program: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env, after?: () => void): void {
  const child = spawn(program, args, { stdio: "inherit", shell: false, env });
  child.on("error", () => process.exit(127));
  child.on("exit", (code, signal) => {
    after?.();
    if (signal) {
      exitBySignal(signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

function exitBySignal(signal: NodeJS.Signals): void {
  process.kill(process.pid, signal);
  setImmediate(() => process.exit(128 + (constants.signals[signal] ?? 0)));
}
