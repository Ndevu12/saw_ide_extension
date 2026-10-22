import * as path from "node:path";

import type { LocateEnv } from "./locate";
import { findPython, type Launcher, type Python, type Runner } from "./python";
import type { RunResult } from "../run";

export interface Pins {
  /** The stayawakebot release this extension was tested against. */
  saw: string;
  /** The pipx release installed when the machine has none. */
  pipx: string;
}

export type StepName = "find-python" | "find-pipx" | "create-venv" | "bootstrap-pipx" | "install-pipx" | "install-saw" | "find-saw";

export interface Step {
  name: StepName;
  command: string;
  exitCode: number | null;
  output: string;
  ok: boolean;
  /** A check that is allowed to fail, such as looking for a pipx the machine may not have. */
  probe: boolean;
}

export type InstallResult =
  | { kind: "installed"; binary: string; binDir: string; pipx: string; installedPipx: boolean; steps: Step[] }
  | { kind: "failed"; failedStep: StepName; steps: Step[]; tried: string[] }
  | { kind: "cancelled"; steps: Step[] };

export interface InstallDeps {
  env: LocateEnv;
  run: Runner;
  makeTempDir: () => string;
  removeDir: (dir: string) => void;
  pins: Pins;
  signal?: AbortSignal;
  /** Told when a step starts, once per step even when it runs several commands, for progress. */
  onStep?: (name: StepName) => void;
  stepTimeoutMs?: number;
}

const WHEELS_ONLY = "--only-binary=:all:";

function tail(text: string, lines = 25): string {
  return text.trim().split(/\r?\n/).slice(-lines).join("\n");
}

function quote(arg: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

class Cancelled extends Error {}
class StepFailed extends Error {
  constructor(readonly step: StepName) {
    super(step);
  }
}

/**
 * Install saw with pipx, installing pipx first when the machine has none. pipx comes from a
 * temporary virtual environment, so nothing is written into the system Python and no administrator
 * rights are needed. Only wheels are installed: no package's build script runs.
 */
export async function installSaw(deps: InstallDeps): Promise<InstallResult> {
  const steps: Step[] = [];
  const timeoutMs = deps.stepTimeoutMs ?? 5 * 60_000;
  const p = deps.env.platform === "win32" ? path.win32 : path.posix;
  const exe = (name: string) => (deps.env.platform === "win32" ? `${name}.exe` : name);

  let announced: StepName | undefined;
  const announce = (name: StepName) => {
    if (name !== announced) {
      announced = name;
      deps.onStep?.(name);
    }
  };

  const step = async (name: StepName, launcher: Launcher, args: string[], options: { mayFail?: boolean } = {}): Promise<RunResult> => {
    announce(name);
    const result = await deps.run(launcher.binary, [...launcher.args, ...args], {
      timeoutMs,
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
    if (result.cancelled) {
      throw new Cancelled();
    }
    const ok = result.exitCode === 0 && !result.spawnError && !result.timedOut;
    steps.push({
      name,
      command: [launcher.binary, ...launcher.args, ...args].map(quote).join(" "),
      exitCode: result.exitCode,
      output: tail(result.spawnError ?? (result.timedOut ? "timed out" : `${result.stdout}\n${result.stderr}`)),
      ok,
      probe: options.mayFail === true,
    });
    if (!ok && !options.mayFail) {
      throw new StepFailed(name);
    }
    return result;
  };

  let tried: string[] = [];
  let temp: string | undefined;
  try {
    announce("find-python");
    const search = await findPython(deps.env, deps.run);
    tried = search.tried;
    const python: Python | undefined = search.found;
    if (!python) {
      steps.push({ name: "find-python", command: "find Python 3.11+", exitCode: null, output: tried.join("\n") || "no interpreter on PATH", ok: false, probe: false });
      return { kind: "failed", failedStep: "find-python", steps, tried };
    }
    const system: Launcher = { binary: python.executable, args: [] };
    const onto = ["--python", python.executable, `--pip-args=${WHEELS_ONLY}`];

    let pipx = await existingPipx(deps, system, step);
    let installedPipx = false;
    if (!pipx) {
      temp = deps.makeTempDir();
      const venv = p.join(temp, "venv");
      await step("create-venv", system, ["-m", "venv", venv]);
      const bootstrap: Launcher = {
        binary: deps.env.platform === "win32" ? p.join(venv, "Scripts", "python.exe") : p.join(venv, "bin", "python"),
        args: [],
      };
      await step("bootstrap-pipx", bootstrap, ["-m", "pip", "install", "--disable-pip-version-check", WHEELS_ONLY, `pipx==${deps.pins.pipx}`]);
      await step("install-pipx", bootstrap, ["-m", "pipx", "install", "--force", ...onto, `pipx==${deps.pins.pipx}`]);
      const binDir = (await step("install-pipx", bootstrap, ["-m", "pipx", "environment", "--value", "PIPX_BIN_DIR"])).stdout.trim();
      pipx = { binary: p.join(binDir, exe("pipx")), args: [] };
      installedPipx = true;
    }

    await step("install-saw", pipx, ["install", "--force", ...onto, `stayawakebot==${deps.pins.saw}`]);
    const binDir = (await step("find-saw", pipx, ["environment", "--value", "PIPX_BIN_DIR"])).stdout.trim();
    const binary = p.join(binDir, exe("saw"));
    if (!binDir || !deps.env.isExecutableFile(binary)) {
      steps.push({ name: "find-saw", command: `check ${binary}`, exitCode: null, output: "pipx finished, but saw is not there", ok: false, probe: false });
      return { kind: "failed", failedStep: "find-saw", steps, tried };
    }
    return { kind: "installed", binary, binDir, pipx: pipx.binary, installedPipx, steps };
  } catch (error) {
    if (error instanceof Cancelled) {
      return { kind: "cancelled", steps };
    }
    if (error instanceof StepFailed) {
      return { kind: "failed", failedStep: error.step, steps, tried };
    }
    throw error;
  } finally {
    if (temp) {
      deps.removeDir(temp);
    }
  }
}

type StepFn = (name: StepName, launcher: Launcher, args: string[], options?: { mayFail?: boolean }) => Promise<RunResult>;

/** A pipx program on PATH or in a known place, else pipx as a module of the chosen Python. */
async function existingPipx(deps: InstallDeps, system: Launcher, step: StepFn): Promise<Launcher | undefined> {
  const p = deps.env.platform === "win32" ? path.win32 : path.posix;
  const name = deps.env.platform === "win32" ? "pipx.exe" : "pipx";
  const dirs = [
    ...(deps.env.pathVariable ?? "").split(p.delimiter).filter((dir) => dir && p.isAbsolute(dir)),
    p.join(deps.env.homedir, ".local", "bin"),
    ...(deps.env.platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : []),
  ];
  for (const dir of dirs) {
    const binary = p.join(dir, name);
    if (deps.env.isExecutableFile(binary)) {
      const launcher = { binary, args: [] };
      if ((await step("find-pipx", launcher, ["--version"], { mayFail: true })).exitCode === 0) {
        return launcher;
      }
    }
  }
  const asModule = { binary: system.binary, args: ["-m", "pipx"] };
  if ((await step("find-pipx", asModule, ["--version"], { mayFail: true })).exitCode === 0) {
    return asModule;
  }
  return undefined;
}
