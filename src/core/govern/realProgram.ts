import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";

import { defaultIsExecutableFile } from "../install/locate";

// The real git and gh sit behind saw's stand-in, which comes first on PATH. A program the stand-in
// runs must be a full path outside every stand-in folder, or running it reaches the stand-in again.
// A folder is matched by what it is on disk, so a symlink or a different spelling of a stand-in
// folder is still that folder.

/**
 * A line in every wrapper this extension writes, so no editor takes one for the real program: not
 * a copy or a hard link, and not another editor's stand-in, whose folder this window does not know.
 */
export const STANDIN_MARK = "saw-govern-standin";

export interface ProgramFiles {
  isExecutableFile(file: string): boolean;
  /** The file a path leads to after symlinks, or undefined when it cannot be followed. */
  realpath(file: string): string | undefined;
  /** A key that is equal for two paths to the same folder, or undefined when the folder cannot be read. */
  folderIdentity(dir: string): string | undefined;
  /** True when the file starts with a wrapper that carries STANDIN_MARK. */
  isMarked(file: string): boolean;
}

export const diskFiles: ProgramFiles = {
  isExecutableFile: defaultIsExecutableFile,
  realpath: (file) => {
    try {
      return realpathSync(file);
    } catch {
      return undefined;
    }
  },
  folderIdentity: (dir) => {
    try {
      const stats = statSync(dir, { bigint: true });
      return stats.isDirectory() ? `${stats.dev}:${stats.ino}` : undefined;
    } catch {
      return undefined;
    }
  },
  isMarked: (file) => {
    let fd: number | undefined;
    try {
      fd = openSync(file, "r");
      const head = Buffer.alloc(512);
      const read = readSync(fd, head, 0, head.length, 0);
      return head.subarray(0, read).toString("latin1").includes(STANDIN_MARK);
    } catch {
      return false;
    } finally {
      if (fd !== undefined) {
        closeSync(fd);
      }
    }
  },
};

/** Path rules for the platform the stand-in runs on. Windows paths compare without case. */
function rules(platform: NodeJS.Platform): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

function spelledInside(file: string, dir: string, platform: NodeJS.Platform): boolean {
  const { relative: relativeTo, isAbsolute } = rules(platform);
  const relative = relativeTo(dir, file);
  return relative === "" || (!relative.startsWith("..") && !isAbsolute(relative));
}

/** True when `dir` is one of the stand-in folders, by spelling or by what it is on disk. */
export function isStandinFolder(dir: string, standinDirs: readonly string[], files: ProgramFiles, platform: NodeJS.Platform = process.platform): boolean {
  const identity = files.folderIdentity(dir);
  return standinDirs.some((standin) => {
    if (!standin) {
      return false;
    }
    if (spelledInside(dir, standin, platform)) {
      return true;
    }
    return identity !== undefined && identity === files.folderIdentity(standin);
  });
}

/** True when `file` is, or leads through a symlink to, a program in a stand-in folder. */
export function isStandin(file: string, standinDirs: readonly string[], files: ProgramFiles, platform: NodeJS.Platform = process.platform): boolean {
  if (files.isMarked(file)) {
    return true;
  }
  const target = files.realpath(file);
  const places = [file, ...(target && target !== file ? [target] : [])];
  return places.some(
    (place) => standinDirs.some((standin) => standin && spelledInside(place, standin, platform)) || isStandinFolder(rules(platform).dirname(place), standinDirs, files, platform),
  );
}

/** A program the stand-in may run: a full path to an executable that is not a stand-in. */
export function isRealProgram(file: string, standinDirs: readonly string[], files: ProgramFiles, platform: NodeJS.Platform = process.platform): boolean {
  return rules(platform).isAbsolute(file) && files.isExecutableFile(file) && !isStandin(file, standinDirs, files, platform);
}

export interface SearchPath {
  pathVariable: string | undefined;
  platform: NodeJS.Platform;
  /** Folders tried after PATH, such as pipx's default folder. */
  extraDirs?: readonly string[];
}

/**
 * The first real `name` on PATH, skipping the stand-in folders. A relative PATH entry is skipped,
 * because it names a folder only relative to wherever the search runs.
 */
export function findRealProgram(name: string, search: SearchPath, standinDirs: readonly string[], files: ProgramFiles): string | undefined {
  const { delimiter, isAbsolute, join } = rules(search.platform);
  const names = search.platform === "win32" ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  const dirs = [...(search.pathVariable ?? "").split(delimiter), ...(search.extraDirs ?? [])];
  for (const dir of dirs) {
    if (!dir || !isAbsolute(dir) || isStandinFolder(dir, standinDirs, files, search.platform)) {
      continue;
    }
    for (const file of names) {
      const candidate = join(dir, file);
      if (isRealProgram(candidate, standinDirs, files, search.platform)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/** Why a recorded program is not run: it leads back to a stand-in, or it is no longer there. */
export type NotRun = "leads-back" | "gone";

export type RealProgramCheck =
  | { kind: "ok"; program: string }
  | { kind: "replaced"; program: string; recorded: string; why: NotRun }
  | { kind: "missing"; recorded: string; why: NotRun };

/**
 * What the stand-in runs for `tool`, given what the configuration recorded. A recorded program that
 * is not a real one is replaced by the real one on PATH when the stand-in folders are known. When
 * they are not known, nothing on PATH can be trusted, since the stand-in comes first there.
 */
export function checkRealProgram(recorded: string, tool: string, standinDirs: readonly string[] | undefined, search: SearchPath, files: ProgramFiles): RealProgramCheck {
  if (recorded && isRealProgram(recorded, standinDirs ?? [], files, search.platform)) {
    return { kind: "ok", program: recorded };
  }
  const { isAbsolute } = rules(search.platform);
  const why: NotRun = !recorded || isAbsolute(recorded) && !isStandin(recorded, standinDirs ?? [], files, search.platform) ? "gone" : "leads-back";
  const found = standinDirs?.length ? findRealProgram(tool, search, standinDirs, files) : undefined;
  return found ? { kind: "replaced", program: found, recorded, why } : { kind: "missing", recorded, why };
}
