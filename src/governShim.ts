import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { applyArgs, prepareArgs, readApply, readPrepare, type GovernConfig } from "./core/govern/contract";
import { folderKey, plan } from "./core/govern/plan";
import { runProgram } from "./core/run";
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

function notice(config: GovernConfig, repo: string, verdict: FolderVerdict, reasons: string[], released: boolean): void {
  const file = path.join(config.resultDir, `${folderKey(repo)}.json`);
  mkdirSync(config.resultDir, { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify({ repo, verdict, reasons, released, at: Date.now() }));
  renameSync(`${file}.tmp`, file);
}

function runReal(program: string, args: readonly string[]): void {
  const child = spawn(program, args, { stdio: "inherit", shell: false });
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
  if (action.kind === "passthrough") {
    if (!action.program) {
      process.stderr.write(`saw could not find ${tool}.\n`);
      process.exit(127);
    }
    runReal(action.program, args);
    return;
  }
  const prepared = await runProgram(config.saw, prepareArgs(action.repo, action.holding, action.tool, action.args), { timeoutMs: config.timeoutMs });
  const reading = readPrepare(prepared.stdout, prepared.exitCode);
  if (!reading.release || prepared.timedOut || prepared.spawnError) {
    const reason = prepared.spawnError
      ? `saw could not be started: ${prepared.spawnError}`
      : prepared.timedOut
        ? "the check did not finish in time"
        : reading.reasons[0] ?? reading.verdict;
    notice(config, action.repo, reading.verdict, reading.reasons, false);
    process.stderr.write(`saw held this update (${reading.verdict}). The folder was not changed. ${reason}\n`);
    process.exit(1);
  }
  mkdirSync(config.markerDir, { recursive: true });
  writeFileSync(path.join(config.markerDir, folderKey(action.repo)), String(Date.now()));
  const applied = await runProgram(config.saw, applyArgs(action.repo, action.holding), { timeoutMs: config.timeoutMs });
  const result = readApply(applied.stdout);
  if (!result.applied || applied.timedOut || applied.spawnError) {
    const reason = result.reason ?? (applied.timedOut ? "the update did not finish in time" : "saw did not update the folder");
    notice(config, action.repo, reading.verdict, [reason], false);
    process.stderr.write(`saw checked this update (${reading.verdict}) but did not change the folder. ${reason}\n`);
    process.exit(1);
  }
  notice(config, action.repo, reading.verdict, reading.reasons, true);
  process.exit(0);
}

void main();
