import { UNCHECKED_CLONE } from "./core/govern/contract";
import { plan } from "./core/govern/plan";
import { describeProgress, ProgressLines } from "./core/scan/progress";
import { holdWithSaw } from "./shim/check";
import { commandArgs, flag, readConfig, withRealPrograms } from "./shim/config";
import { notice } from "./shim/notice";
import { aliasOf, entriesIn, guardGit, landed, runPlaced, runReal, runRealOrExit } from "./shim/run";

// The program the editor runs instead of git and gh. It asks saw to check an update that brings
// files into an open folder, and otherwise runs the real program.

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

void main();
