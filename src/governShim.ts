import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { applyArgs, prepareArgs, readApply, readPrepare, UNCHECKED_CLONE, type GovernConfig, type GovernPhase } from "./core/govern/contract";
import { activationEnv, folderKey, plan, type Hold } from "./core/govern/plan";
import { checkRealProgram, diskFiles, pathWithoutStandins } from "./core/govern/realProgram";
import { enclosingFolder, parseGit, quietGit, repoConfigText, silencedRepoConfig, type Tool } from "./core/govern/command";
import { runProgram } from "./core/run";
import { describeProgress, ProgressLines } from "./core/scan/progress";
import type { FolderVerdict } from "./core/scan/verdict";

// The program the editor runs instead of git and gh. It asks saw to check an update that brings
// files into an open folder, and otherwise runs the real program.

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function commandArgs(): string[] {
  const index = process.argv.indexOf("--");
  return index === -1 ? [] : process.argv.slice(index + 1);
}

function readConfig(file: string): GovernConfig | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as GovernConfig;
  } catch {
    return undefined;
  }
}

/**
 * The configuration with git and gh checked, so nothing below runs a stand-in. A recorded program
 * that would lead back here is replaced by the real one on PATH, or left empty so it is not run.
 * Only the tool being run is reported, so a git command does not talk about gh.
 */
function withRealPrograms(config: GovernConfig, tool: Tool): GovernConfig {
  const search = { pathVariable: process.env["PATH"], platform: process.platform };
  const real = (recorded: string, name: Tool): string => {
    const check = checkRealProgram(recorded, name, config.standinDirs, search, diskFiles);
    if (name === tool && check.kind !== "ok" && check.recorded) {
      const problem = check.why === "gone" ? "is no longer there" : "would run saw's stand-in again";
      const instead = check.kind === "replaced" ? `so it runs ${check.program}` : "and no other was found";
      process.stderr.write(`saw: the recorded ${name}, ${check.recorded}, ${problem}, ${instead}. Reload the window so saw records ${name} again.\n`);
    }
    return check.kind === "missing" ? "" : check.program;
  };
  return { ...config, realGit: real(config.realGit, "git"), realGh: real(config.realGh, "gh") };
}

function notice(config: GovernConfig, repo: string, phase: GovernPhase, reasons: string[], verdict?: FolderVerdict, step?: string): void {
  const file = path.join(config.resultDir, `${folderKey(repo)}.json`);
  mkdirSync(config.resultDir, { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify({
    repo,
    phase,
    reasons,
    at: Date.now(),
    ...(verdict ? { verdict } : {}),
    ...(step ? { step } : {}),
  }));
  renameSync(`${file}.tmp`, file);
}

function runPlaced(config: GovernConfig, tool: Tool, args: readonly string[], holding: string, onStderr: (text: string) => void, onExit: (code: number, spawnFailed: boolean) => void): void {
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
      process.kill(process.pid, signal);
      return;
    }
    onExit(code ?? 1, false);
  });
}

function runRealOrExit(config: GovernConfig, tool: Tool, args: readonly string[], after?: () => void): void {
  const program = tool === "git" ? config.realGit : config.realGh;
  if (!program) {
    process.stderr.write(`saw could not find ${tool}.\n`);
    process.exit(127);
  }
  const guarded = guardGit(config, tool, args);
  runReal(program, guarded.args, guarded.env, after);
}

/** `alias.<name>` as the real git reads it for that repository, or undefined. */
function aliasOf(config: GovernConfig): (name: string, directory: string) => string | undefined {
  return (name, directory) => {
    if (!config.realGit) {
      return undefined;
    }
    const read = spawnSync(config.realGit, ["-C", directory, "config", "--get", `alias.${name}`], { encoding: "utf8", timeout: 5000, shell: false });
    return read.status === 0 && read.stdout.trim() ? read.stdout.trim() : undefined;
  };
}


/** Git aimed at an open folder does not run that folder's fsmonitor, external diff, hooks, or other filters. */
function guardGit(config: GovernConfig, tool: Tool, args: readonly string[]): { args: readonly string[]; env: NodeJS.ProcessEnv } {
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

function injectsConfig(key: string): boolean {
  return key === "GIT_CONFIG" || key === "GIT_CONFIG_PARAMETERS" || key === "GIT_CONFIG_COUNT" || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key);
}

function withoutConfigInjection(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !injectsConfig(key)));
}

function runReal(program: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env, after?: () => void): void {
  const child = spawn(program, args, { stdio: "inherit", shell: false, env });
  child.on("error", () => process.exit(127));
  child.on("exit", (code, signal) => {
    after?.();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

async function main(): Promise<void> {
  const configPath = flag("--config");
  const tool = flag("--tool");
  const args = commandArgs();
  const recorded = configPath ? readConfig(configPath) : undefined;
  if (!recorded || (tool !== "git" && tool !== "gh")) {
    process.stderr.write("saw could not read its git stand-in configuration.\n");
    process.exit(1);
  }
  const config = withRealPrograms(recorded, tool);
  if (!(tool === "git" ? config.realGit : config.realGh)) {
    // Nothing runs without the real program, not even saw's stand-in, which would look it up on PATH and find this one.
    process.stderr.write(`saw could not find ${tool}.\n`);
    process.exit(127);
  }
  const action = plan(config, tool, args, process.cwd(), { env: process.env, aliasOf: aliasOf(config) });
  const scanAfter = action.kind === "passthrough" ? action.scanAfter : undefined;
  const after = scanAfter ? () => notice(config, scanAfter, "finished", [UNCHECKED_CLONE]) : undefined;
  if (config.standin && action.kind === "passthrough") {
    runPlaced(config, tool, args, config.holdingRoot, () => undefined, (code, spawnFailed) => {
      if (spawnFailed) {
        runRealOrExit(config, tool, args, after);
        return;
      }
      after?.();
      process.exit(code);
    });
    return;
  }
  if (config.standin && action.kind === "hold") {
    const steps = new ProgressLines((progress) => {
      if (progress) {
        notice(config, action.repo, "checking", [], undefined, describeProgress(progress));
      }
    });
    let stderr = "";
    notice(config, action.repo, "checking", []);
    runPlaced(config, tool, args, action.holding, (text) => {
      stderr += text;
      steps.feed(text);
    }, (code, spawnFailed) => {
      steps.end();
      if (stderr.includes("held this update")) {
        notice(config, action.repo, "held", ["saw held this update. The folder was not changed."]);
        process.exit(code);
        return;
      }
      if (spawnFailed) {
        // saw's stand-in did not start, so this window's own check holds the update instead.
        void holdWithSaw(config, action);
        return;
      }
      notice(config, action.repo, "finished", []);
      process.exit(code);
    });
    return;
  }
  if (action.kind === "passthrough") {
    if (!action.program) {
      process.stderr.write(`saw could not find ${tool}.\n`);
      process.exit(127);
    }
    const guarded = guardGit(config, tool, args);
    runReal(action.program, guarded.args, guarded.env, after);
    return;
  }
  await holdWithSaw(config, action);
}

/** Ask saw to check the update into a holding folder, and let it into the open folder only when saw says so. */
async function holdWithSaw(config: GovernConfig, action: Hold): Promise<void> {
  const steps = new ProgressLines((progress) => {
    if (progress) {
      notice(config, action.repo, "checking", [], undefined, describeProgress(progress));
    }
  });
  notice(config, action.repo, "checking", []);
  const prepared = await runProgram(config.saw, prepareArgs(action.repo, action.holding, action.tool, action.args, config.progress), {
    timeoutMs: config.timeoutMs,
    onOutput: (text, stream) => {
      if (stream === "stderr") {
        steps.feed(text);
      }
    },
  });
  steps.end();
  const reading = readPrepare(prepared.stdout, prepared.exitCode);
  if (!reading.release || prepared.timedOut || prepared.spawnError) {
    const reason = prepared.spawnError
      ? `saw could not be started: ${prepared.spawnError}`
      : prepared.timedOut
        ? "the check did not finish in time"
        : reading.reasons[0] ?? reading.verdict;
    notice(config, action.repo, "held", reading.reasons, reading.verdict);
    process.stderr.write(`saw held this update (${reading.verdict}). The folder was not changed. ${reason}\n`);
    process.exit(1);
  }
  mkdirSync(config.markerDir, { recursive: true });
  writeFileSync(path.join(config.markerDir, folderKey(action.repo)), String(Date.now()));
  const applied = await runProgram(config.saw, applyArgs(action.repo, action.holding), { timeoutMs: config.timeoutMs });
  const result = readApply(applied.stdout);
  if (!result.applied || applied.timedOut || applied.spawnError) {
    const reason = result.reason ?? (applied.timedOut ? "the update did not finish in time" : "saw did not update the folder");
    notice(config, action.repo, "held", [reason], reading.verdict);
    process.stderr.write(`saw checked this update (${reading.verdict}) but did not change the folder. ${reason}\n`);
    process.exit(1);
  }
  notice(config, action.repo, "applied", reading.reasons, reading.verdict);
  process.exit(0);
}

void main();
