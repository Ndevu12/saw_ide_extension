import * as path from "node:path";

import type { LocateEnv } from "./locate";
import type { RunOptions, RunResult } from "./run";

/** saw's `requires-python`. */
export const MIN_PYTHON: readonly [number, number] = [3, 11];

export type Runner = (binary: string, args: readonly string[], options: RunOptions) => Promise<RunResult>;

export interface Python {
  /** The interpreter itself, never a virtual environment's copy: what pipx builds saw's environment on. */
  executable: string;
  version: readonly [number, number];
}

export interface Launcher {
  binary: string;
  args: string[];
}

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

/** Interpreters worth asking, newest first. On Windows, the Store's `python.exe` stub opens the Store instead of running. */
export function pythonLaunchers(env: LocateEnv): Launcher[] {
  const p = pathApi(env.platform);
  const dirs = (env.pathVariable ?? "").split(p.delimiter).filter((dir) => dir && p.isAbsolute(dir));
  const launchers: Launcher[] = [];
  const seen = new Set<string>();
  const add = (binary: string, args: string[] = []) => {
    if (!seen.has(binary) && env.isExecutableFile(binary)) {
      seen.add(binary);
      launchers.push({ binary, args });
    }
  };
  if (env.platform === "win32") {
    for (const dir of [...dirs, "C:\\Windows"]) add(p.join(dir, "py.exe"), ["-3"]);
    for (const dir of dirs.filter((d) => !/\\WindowsApps\\?$/i.test(d))) add(p.join(dir, "python.exe"));
    return launchers;
  }
  const names = ["python3.14", "python3.13", "python3.12", "python3.11", "python3"];
  const known = env.platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] : ["/usr/local/bin", "/usr/bin"];
  for (const name of names) {
    for (const dir of [...dirs, ...known]) add(p.join(dir, name));
  }
  return launchers;
}

const PROBE = "import sys; print(sys.version_info[0], sys.version_info[1]); print(getattr(sys, '_base_executable', '') or sys.executable)";

export interface PythonSearch {
  found: Python | undefined;
  /** What each interpreter said, for the diagnosis when none fits. */
  tried: string[];
}

export async function findPython(env: LocateEnv, run: Runner, timeoutMs = 20_000): Promise<PythonSearch> {
  const tried: string[] = [];
  for (const launcher of pythonLaunchers(env)) {
    const result = await run(launcher.binary, [...launcher.args, "-c", PROBE], { timeoutMs });
    const [versionLine, executable] = result.stdout.trim().split(/\r?\n/);
    const match = /^(\d+) (\d+)$/.exec(versionLine ?? "");
    if (result.exitCode !== 0 || !match || !executable) {
      tried.push(`${launcher.binary}: did not run (${result.spawnError ?? `status ${result.exitCode}`})`);
      continue;
    }
    const version = [Number(match[1]), Number(match[2])] as const;
    tried.push(`${launcher.binary}: Python ${version.join(".")} at ${executable.trim()}`);
    if (version[0] > MIN_PYTHON[0] || (version[0] === MIN_PYTHON[0] && version[1] >= MIN_PYTHON[1])) {
      return { found: { executable: executable.trim(), version }, tried };
    }
  }
  return { found: undefined, tried };
}
