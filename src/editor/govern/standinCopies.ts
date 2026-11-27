import { copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import * as nodePath from "node:path";

import type { StandinTool } from "../../core/govern/places";
import { copyName } from "../../core/govern/windowsPlaces";

export interface CopyFiles {
  makeFolder(dir: string): void;
  list(dir: string): string[];
  exists(file: string): boolean;
  sameBytes(one: string, other: string): boolean;
  copy(from: string, to: string): void;
  rename(from: string, to: string): void;
  remove(file: string): void;
}

export const diskCopies: CopyFiles = {
  makeFolder: (dir) => mkdirSync(dir, { recursive: true }),
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  exists: (file) => {
    try {
      return statSync(file).isFile();
    } catch {
      return false;
    }
  },
  sameBytes: (one, other) => {
    try {
      return statSync(one).size === statSync(other).size && readFileSync(one).equals(readFileSync(other));
    } catch {
      return false;
    }
  },
  copy: (from, to) => copyFileSync(from, to),
  rename: (from, to) => renameSync(from, to),
  remove: (file) => rmSync(file, { force: true }),
};

export interface NotRemoved {
  file: string;
  reason: string;
}

export interface Copied {
  git: string | undefined;
  notRemoved: NotRemoved[];
}

/** Copy saw's stand-in into `bin` once for each tool, and take out every other file there. */
export function placeCopies(standin: string, bin: string, tools: readonly StandinTool[], files: CopyFiles): Copied {
  files.makeFolder(bin);
  const keep = new Set(tools.map((tool) => copyName(tool)));
  const notRemoved = clearCopies(bin, files, keep);
  for (const tool of tools) {
    const notMoved = refresh(standin, nodePath.join(bin, copyName(tool)), files);
    if (notMoved) {
      notRemoved.push(notMoved);
    }
  }
  return { git: tools.includes("git") ? nodePath.join(bin, copyName("git")) : undefined, notRemoved };
}

/** Remove the files in `bin` other than `keep`. Returns those that are still in use. */
export function clearCopies(bin: string, files: CopyFiles, keep: ReadonlySet<string> = new Set()): NotRemoved[] {
  const notRemoved: NotRemoved[] = [];
  for (const name of files.list(bin)) {
    if (keep.has(name.toLowerCase())) {
      continue;
    }
    const file = nodePath.join(bin, name);
    try {
      files.remove(file);
    } catch (error) {
      notRemoved.push({ file, reason: String(error) });
    }
  }
  return notRemoved;
}

function refresh(standin: string, copy: string, files: CopyFiles): NotRemoved | undefined {
  if (files.exists(copy) && files.sameBytes(standin, copy)) {
    return undefined;
  }
  const stamp = `${process.pid}.${Date.now()}`;
  const fresh = `${copy}.${stamp}.new`;
  files.copy(standin, fresh);
  if (!files.exists(copy)) {
    files.rename(fresh, copy);
    return undefined;
  }
  const aside = `${copy}.${stamp}.old`;
  files.rename(copy, aside);
  try {
    files.rename(fresh, copy);
  } catch (error) {
    try {
      files.rename(aside, copy);
    } catch (restoring) {
      throw new Error(`${String(error)}, and the earlier copy could not be put back: ${String(restoring)}`, { cause: restoring });
    }
    throw error;
  }
  try {
    files.remove(aside);
    return undefined;
  } catch (error) {
    return { file: aside, reason: String(error) };
  }
}
