import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { withDeadline } from "../core/deadline";
import { applyArgs, prepareArgs, readApply, readPrepare, UNCHECKED_UPDATE, type GovernConfig } from "../core/govern/contract";
import { DECISION_ENV } from "../core/govern/decision";
import { findingLines, foundSomething, heldFileName, heldNextSteps, LET_IN_UPDATE, readHeldRecord, sawNextSteps } from "../core/govern/held";
import { folderKey, type Hold } from "../core/govern/plan";
import { runProgram } from "../core/run";
import { describeProgress, ProgressLines } from "../core/scan/progress";
import type { FolderVerdict } from "../core/scan/verdict";
import { decide, decideHeld } from "./ask";
import { notice } from "./notice";
import { runRealOrExit } from "./run";

export async function leaveToOperator(config: GovernConfig, action: Hold, typed: readonly string[], reason: string, releasedButNotApplied?: FolderVerdict): Promise<void> {
  const decision = await decide(config, action, typed, reason, releasedButNotApplied);
  if (decision === "run-as-typed") {
    process.stderr.write("saw: running it as typed. The folder is scanned straight after.\n");
    runUnchecked(config, action, typed, reason);
    return;
  }
  notice(config, action.repo, "finished", []);
  process.stderr.write(`saw left the folder unchanged; ${action.tool} did not run. To run it as typed, answer yes, or set ${DECISION_ENV}=run-as-typed.\n`);
  process.exit(1);
}

export function runUnchecked(config: GovernConfig, action: Hold, typed: readonly string[], reason: string): void {
  runRealOrExit(config, action.tool, typed, () => notice(config, action.repo, "finished", [UNCHECKED_UPDATE, reason]));
}

/** Ask saw to check the update into a holding folder, and let it into the open folder only when saw says so. `typed` is the command as the operator typed it. */
export async function holdWithSaw(config: GovernConfig, action: Hold, typed: readonly string[]): Promise<void> {
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
  const limit = withDeadline(config.timeoutMs, config.deadline === true);
  const prepared = await runProgram(config.saw, prepareArgs(action.repo, action.holding, action.tool, action.args, config.progress, limit.args), {
    timeoutMs: limit.timeoutMs,
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
    await applyChecked(config, action, typed, reading.verdict, reading.reasons, reading.stateId);
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
  if (checked && reading.unchecked && !config.decides) {
    // An older saw cannot check most updates and offers no decision, so holding would only stop the operator.
    process.stderr.write(`saw could not check this update first (${reason}), so it ran unchecked. saw scans the folder now.\n`);
    runUnchecked(config, action, typed, reason);
    return;
  }
  // saw judged nothing, so the operator decides: holding for good would stop them working on their own project.
  await leaveToOperator(config, action, typed, reason);
}

/** saw found something in the update. Keep what it found, say what to do, and let the operator bring it in anyway. */
export async function holdFound(config: GovernConfig, action: Hold, typed: readonly string[], verdict: FolderVerdict, reasons: string[], answerText: string): Promise<void> {
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

export async function applyChecked(config: GovernConfig, action: Hold, typed: readonly string[], verdict: FolderVerdict, reasons: string[], stateId: string | undefined): Promise<void> {
  const marker = path.join(config.markerDir, folderKey(action.repo));
  mkdirSync(config.markerDir, { recursive: true });
  writeFileSync(marker, String(Date.now()));
  const expect = config.exactApply ? stateId : undefined;
  const applied = await runProgram(config.saw, applyArgs(action.repo, action.holding, expect), { timeoutMs: config.timeoutMs });
  const result = readApply(applied.stdout);
  if (!result.applied || applied.timedOut || applied.spawnError) {
    rmSync(marker, { force: true });
    const reason = applied.timedOut ? "the update did not finish in time" : result.reason ?? "saw did not update the folder";
    if (expect && result.outcome === "not_brought_in" && !applied.timedOut) {
      await leaveToOperator(config, action, typed, reason, verdict);
      return;
    }
    if (result.outcome === "folder_may_have_changed" || applied.timedOut || (expect && !result.outcome && !applied.spawnError)) {
      notice(config, action.repo, "finished", [UNCHECKED_UPDATE, reason]);
      process.stderr.write(`saw could not finish bringing in this update: ${reason}. The folder is scanned now.\n`);
      process.exit(1);
    }
    notice(config, action.repo, "finished", []);
    process.stderr.write(`saw did not change the folder: ${reason}.\n`);
    process.exit(1);
  }
  notice(config, action.repo, "applied", reasons, verdict);
  process.exit(0);
}
