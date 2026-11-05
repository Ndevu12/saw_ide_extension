import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { applyArgs, prepareArgs, readApply, readPrepare, type GovernConfig, type GovernPhase } from "./core/govern/contract";
import { activationEnv, folderKey, plan } from "./core/govern/plan";
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
  const child = spawn(standin, guarded.args, {
    stdio: ["inherit", "inherit", "pipe"],
    shell: false,
    env: { ...guarded.env, ...activationEnv(config, tool, holding) },
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

function runRealOrExit(config: GovernConfig, tool: Tool, args: readonly string[]): void {
  const program = tool === "git" ? config.realGit : config.realGh;
  if (!program) {
    process.stderr.write(`saw could not find ${tool}.\n`);
    process.exit(127);
  }
  const guarded = guardGit(config, tool, args);
  runReal(program, guarded.args, guarded.env);
}

/** Git aimed at an open folder does not run that folder's fsmonitor, external diff, hooks, or other filters. */
function guardGit(config: GovernConfig, tool: Tool, args: readonly string[]): { args: readonly string[]; env: NodeJS.ProcessEnv } {
  if (tool !== "git" || !config.quietHooks) {
    return { args, env: process.env };
  }
  const directory = parseGit(args, process.cwd())?.directory ?? process.cwd();
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

function runReal(program: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): void {
  const child = spawn(program, args, { stdio: "inherit", shell: false, env });
  child.on("error", () => process.exit(127));
  child.on("exit", (code, signal) => {
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
  const config = configPath ? readConfig(configPath) : undefined;
  if (!config || (tool !== "git" && tool !== "gh")) {
    process.stderr.write("saw could not read its git stand-in configuration.\n");
    process.exit(1);
  }
  const action = plan(config, tool, args, process.cwd());
  if (config.standin && action.kind === "passthrough") {
    runPlaced(config, tool, args, config.holdingRoot, () => undefined, (code, spawnFailed) => {
      if (spawnFailed) {
        runRealOrExit(config, tool, args);
        return;
      }
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
      notice(config, action.repo, "finished", []);
      if (spawnFailed) {
        runRealOrExit(config, tool, args);
        return;
      }
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
    runReal(action.program, guarded.args, guarded.env);
    return;
  }
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
