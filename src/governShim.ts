import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";

import { applyArgs, prepareArgs, readApply, readPrepare, UNCHECKED_CLONE, UNCHECKED_UPDATE, type GovernConfig, type GovernPhase } from "./core/govern/contract";
import { answerFileName, ASK_EDITOR_MS, askFileName, DECISION_ENV, decisionFromEnv, heldTerminalAnswer, heldTerminalQuestion, readAnswer, terminalAnswer, terminalQuestion, type Decision, type UpdateAsk } from "./core/govern/decision";
import { findingLines, foundSomething, heldFileName, heldNextSteps, LET_IN_UPDATE, readHeldRecord, sawNextSteps } from "./core/govern/held";
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

/** How many entries a folder has, or undefined when it does not exist. */
function entriesIn(dir: string): number | undefined {
  try {
    return readdirSync(dir).length;
  } catch {
    return undefined;
  }
}

/** Whether a clone left a checkout: a new folder, or files in a folder that was empty. */
function landed(before: number | undefined, now: number | undefined): boolean {
  return now !== undefined && now > 0 && (before === undefined || before === 0);
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
  const landsAt = action.kind === "passthrough" ? action.landsAt : undefined;
  // Judged by what landed, not by the exit code: a clone can fail partway and leave its checkout.
  const before = landsAt ? entriesIn(landsAt) : undefined;
  const after = scanAfter && landsAt
    ? () => {
      if (landed(before, entriesIn(landsAt))) {
        notice(config, scanAfter, "finished", [UNCHECKED_CLONE]);
      }
    }
    : undefined;
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
  // saw's stand-in holds an update with no way to let it in from the editor, so with an editor to ask this one checks it.
  if (config.standin && action.kind === "hold" && !config.askDir) {
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
        void holdWithSaw(config, action, args);
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
  await holdWithSaw(config, action, args);
}

/** Stopped while waiting for a decision: nothing ran, so the folder is as it was. */
function exitOnStop(cleanup: () => void): void {
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(name, () => {
      cleanup();
      process.exit(130);
    });
  }
}

/** Whether a person at this terminal can answer a question. */
function terminalAnswers(): boolean {
  return process.stdin.isTTY === true && process.stderr.isTTY === true;
}

/** The operator's decision about an update saw could not check. With no one to ask, the folder is left as it is. */
async function decide(config: GovernConfig, action: Hold, typed: readonly string[], reason: string): Promise<Decision> {
  const ahead = decisionFromEnv(process.env);
  if (ahead) {
    return ahead;
  }
  if (terminalAnswers()) {
    return askTerminal(terminalQuestion(action.tool, typed, reason), terminalAnswer);
  }
  if (config.askDir) {
    const ask = { id: randomUUID(), repo: action.repo, tool: action.tool, args: [...typed], reason, at: Date.now() };
    return askEditor(config.askDir, ask, `saw cannot check this update: ${reason}.`, "The editor asks whether to run it as typed.");
  }
  process.stderr.write(`saw cannot check this update: ${reason}.\n`);
  return "leave-unchanged";
}

/**
 * Whether the operator lets in an update saw held for what it found. Deciding ahead with
 * SAW_GOVERN_DECISION does not count here: that is for updates saw could not check.
 */
async function decideHeld(config: GovernConfig, action: Hold, typed: readonly string[], verdict: FolderVerdict, reason: string): Promise<boolean> {
  if (terminalAnswers()) {
    return (await askTerminal(heldTerminalQuestion(verdict, action.repo), (line) => heldTerminalAnswer(line, verdict, action.repo))) === "run-as-typed";
  }
  if (config.askDir) {
    const ask = { id: randomUUID(), repo: action.repo, tool: action.tool, args: [...typed], reason, at: Date.now(), held: verdict };
    return (await askEditor(config.askDir, ask, "", "The editor shows what was found and asks whether to let it in.")) === "run-as-typed";
  }
  return false;
}

function askTerminal(question: string, read: (line: string) => Decision): Promise<Decision> {
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
async function askEditor(dir: string, ask: UpdateAsk, why: string, waiting: string): Promise<Decision> {
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

/** Ask saw to check the update into a holding folder, and let it into the open folder only when saw says so. `typed` is the command as the operator typed it. */
async function holdWithSaw(config: GovernConfig, action: Hold, typed: readonly string[]): Promise<void> {
  const steps = new ProgressLines((progress) => {
    if (progress) {
      notice(config, action.repo, "checking", [], undefined, describeProgress(progress));
    }
  });
  notice(config, action.repo, "checking", []);
  // saw runs in its own process group, so the terminal's Ctrl-C reaches it only through here. Apply is never interrupted, so the folder is not left half-written.
  const interrupted = new AbortController();
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(name, () => interrupted.abort());
  }
  const prepared = await runProgram(config.saw, prepareArgs(action.repo, action.holding, action.tool, action.args, config.progress), {
    timeoutMs: config.timeoutMs,
    signal: interrupted.signal,
    onOutput: (text, stream) => {
      if (stream === "stderr") {
        steps.feed(text);
      }
    },
  });
  steps.end();
  if (prepared.cancelled) {
    notice(config, action.repo, "finished", []);
    process.stderr.write("saw stopped checking this update. The folder was not changed.\n");
    process.exit(130);
  }
  const reading = readPrepare(prepared.stdout, prepared.exitCode);
  const checked = !prepared.timedOut && !prepared.spawnError;
  if (checked && reading.release) {
    await applyChecked(config, action, reading.verdict, reading.reasons);
    return;
  }
  if (checked && reading.scanned && foundSomething(reading.verdict)) {
    await holdFound(config, action, typed, reading.verdict, reading.reasons, prepared.stdout);
    return;
  }
  const reason = prepared.spawnError
    ? `saw could not be started: ${prepared.spawnError}`
    : prepared.timedOut
      ? "the check did not finish in time"
      : reading.reasons[0] ?? reading.verdict;
  const runUnchecked = () => runRealOrExit(config, action.tool, typed, () => notice(config, action.repo, "finished", [UNCHECKED_UPDATE, reason]));
  if (checked && reading.unchecked && !config.decides) {
    // An older saw cannot check most updates and offers no decision, so holding would only stop the operator.
    process.stderr.write(`saw could not check this update first (${reason}), so it ran unchecked. saw scans the folder now.\n`);
    runUnchecked();
    return;
  }
  // saw judged nothing, so the operator decides: holding for good would stop them working on their own project.
  const decision = await decide(config, action, typed, reason);
  if (decision === "run-as-typed") {
    process.stderr.write("saw: running it as typed. The folder is scanned straight after.\n");
    runUnchecked();
    return;
  }
  notice(config, action.repo, "finished", []);
  process.stderr.write(`saw left the folder unchanged; ${action.tool} did not run. To run it as typed, answer yes, or set ${DECISION_ENV}=run-as-typed.\n`);
  process.exit(1);
}

/** saw found something in the update. Keep what it found, say what to do, and let the operator bring it in anyway. */
async function holdFound(config: GovernConfig, action: Hold, typed: readonly string[], verdict: FolderVerdict, reasons: string[], answerText: string): Promise<void> {
  let answer: unknown;
  try {
    answer = JSON.parse(answerText);
  } catch {
    answer = undefined;
  }
  const scan = (answer as { scan?: unknown } | undefined)?.scan;
  const fromSaw = sawNextSteps(answer);
  const nextSteps = fromSaw.length ? fromSaw : heldNextSteps(verdict, action.tool, typed);
  const record = { repo: action.repo, at: Date.now(), tool: action.tool, args: [...typed], verdict, reasons, scan, nextSteps };
  const kept = readHeldRecord(JSON.stringify(record));
  try {
    mkdirSync(config.resultDir, { recursive: true });
    const file = path.join(config.resultDir, heldFileName(folderKey(action.repo)));
    writeFileSync(`${file}.tmp`, JSON.stringify(record));
    renameSync(`${file}.tmp`, file);
  } catch {
    // The editor then shows the verdict and reasons without the findings.
  }
  notice(config, action.repo, "held", reasons, verdict);
  const lines = [
    `saw held this update (${verdict}). The folder was not changed.${reasons[0] ? ` ${reasons[0]}` : ""}`,
    ...(kept ? findingLines(kept.scan) : []),
    "What to do:",
    ...nextSteps.map((step) => `  - ${step}`),
  ];
  process.stderr.write(`${lines.join("\n")}\n`);
  const letIn = await decideHeld(config, action, typed, verdict, reasons[0] ?? verdict);
  if (!letIn) {
    process.stderr.write(`saw left the folder unchanged; ${action.tool} did not run.\n`);
    process.exit(1);
  }
  process.stderr.write(`saw: letting it in as you asked (${verdict}). The folder is scanned straight after.\n`);
  runRealOrExit(config, action.tool, typed, () => notice(config, action.repo, "finished", [LET_IN_UPDATE, `${verdict}: ${reasons[0] ?? "held"}`]));
}

async function applyChecked(config: GovernConfig, action: Hold, verdict: FolderVerdict, reasons: string[]): Promise<void> {
  mkdirSync(config.markerDir, { recursive: true });
  writeFileSync(path.join(config.markerDir, folderKey(action.repo)), String(Date.now()));
  const applied = await runProgram(config.saw, applyArgs(action.repo, action.holding), { timeoutMs: config.timeoutMs });
  const result = readApply(applied.stdout);
  if (!result.applied || applied.timedOut || applied.spawnError) {
    const reason = result.reason ?? (applied.timedOut ? "the update did not finish in time" : "saw did not update the folder");
    notice(config, action.repo, "held", [reason], verdict);
    process.stderr.write(`saw checked this update (${verdict}) but did not change the folder. ${reason}\n`);
    process.exit(1);
  }
  notice(config, action.repo, "applied", reasons, verdict);
  process.exit(0);
}

void main();
