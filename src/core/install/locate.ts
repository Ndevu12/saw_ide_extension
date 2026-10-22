import { accessSync, constants, statSync } from "node:fs";
import * as path from "node:path";

import { runProgram } from "../run";
import { atLeast, MIN_SAW_VERSION, parseVersion, type Version } from "../version";

export interface LocateEnv {
  platform: NodeJS.Platform;
  homedir: string;
  pathVariable: string | undefined;
  isExecutableFile: (file: string) => boolean;
}

export function defaultIsExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) {
      return false;
    }
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

function programName(platform: NodeJS.Platform): string {
  // A .cmd or .bat launcher only runs through a shell, which this extension never starts.
  return platform === "win32" ? "saw.exe" : "saw";
}

/** Where pipx, uv and Homebrew put `saw`; an editor started from a desktop launcher often lacks these on PATH. */
function knownDirectories(env: LocateEnv): string[] {
  const p = pathApi(env.platform);
  const dirs = [p.join(env.homedir, ".local", "bin")];
  if (env.platform === "darwin") {
    dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  }
  return dirs;
}

export interface Candidate {
  binary: string;
  from: "setting" | "path" | "known-location" | "installed";
}

export type Located =
  | { kind: "found"; candidates: Candidate[] }
  | { kind: "missing"; searched: string[] }
  | { kind: "invalid-setting"; reason: string };

/**
 * Find the saw programs worth asking, as absolute paths, best first: the setting alone when there
 * is one; otherwise PATH, the usual install directories, then the one this extension installed.
 * Relative PATH entries are skipped: they name the working directory.
 */
export function locate(configured: string, env: LocateEnv, installed?: string): Located {
  const p = pathApi(env.platform);
  const name = programName(env.platform);
  const setting = configured.trim();
  if (setting) {
    if (!p.isAbsolute(setting)) {
      return { kind: "invalid-setting", reason: `saw.path must be an absolute path; got ${setting}` };
    }
    if (env.platform === "win32" && !setting.toLowerCase().endsWith(".exe")) {
      return { kind: "invalid-setting", reason: `saw.path must name saw.exe; got ${setting}` };
    }
    if (!env.isExecutableFile(setting)) {
      return { kind: "invalid-setting", reason: `saw.path does not name a program this account can run: ${setting}` };
    }
    return { kind: "found", candidates: [{ binary: setting, from: "setting" }] };
  }

  const searched: string[] = [];
  const candidates: Candidate[] = [];
  const consider = (binary: string, from: Candidate["from"]) => {
    if (searched.includes(binary)) {
      return;
    }
    searched.push(binary);
    if (env.isExecutableFile(binary)) {
      candidates.push({ binary, from });
    }
  };
  for (const dir of (env.pathVariable ?? "").split(p.delimiter).filter((d) => d && p.isAbsolute(d))) {
    consider(p.join(dir, name), "path");
  }
  for (const dir of knownDirectories(env)) {
    consider(p.join(dir, name), "known-location");
  }
  if (installed && p.isAbsolute(installed)) {
    consider(installed, "installed");
  }
  return candidates.length ? { kind: "found", candidates } : { kind: "missing", searched };
}

export type Probed =
  | { kind: "ready"; binary: string; version: Version }
  | { kind: "too-old"; binary: string; version: Version; minimum: string }
  | { kind: "unrecognised"; binary: string; detail: string };

/** Ask a located program for its version, so a stale or foreign `saw` is never trusted with a verdict. */
export async function probe(binary: string, timeoutMs = 15_000): Promise<Probed> {
  const run = await runProgram(binary, ["--version"], { timeoutMs, maxOutputBytes: 64 * 1024 });
  const version = parseVersion(run.stdout);
  if (!version) {
    const detail = run.spawnError ?? (run.timedOut ? "it did not answer `--version` in time" : (run.stderr || run.stdout).trim().slice(0, 300));
    return { kind: "unrecognised", binary, detail: detail || "it printed no version" };
  }
  if (!atLeast(version, MIN_SAW_VERSION)) {
    return { kind: "too-old", binary, version, minimum: MIN_SAW_VERSION };
  }
  return { kind: "ready", binary, version };
}
