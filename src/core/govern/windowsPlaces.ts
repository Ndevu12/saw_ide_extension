import * as path from "node:path";

import type { ProgramFiles, StandinTool } from "./places";

const EXTENSIONS_WHEN_UNSET = ".COM;.EXE;.BAT;.CMD";

/** The file this editor copies saw's stand-in to for a tool. */
export function copyName(tool: StandinTool): string {
  return `${tool}.exe`;
}

/** saw's stand-in where saw says it is, when that is a program this editor can copy. */
export function windowsStandin(named: string | undefined, files: Pick<ProgramFiles, "isExecutableFile">): string | undefined {
  if (!named || !path.win32.isAbsolute(named) || path.win32.extname(named).toLowerCase() !== ".exe") {
    return undefined;
  }
  return files.isExecutableFile(named) ? named : undefined;
}

/** The folders in a Windows PATH, read as saw's stand-in reads them. */
export function windowsPathFolders(pathVariable: string | undefined): string[] {
  const folders: string[] = [];
  let current = "";
  let quoted = false;
  for (const character of pathVariable ?? "") {
    if (character === "\"") {
      quoted = !quoted;
    } else if (character === ";" && !quoted) {
      folders.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  folders.push(current);
  return folders.filter((folder) => folder !== "");
}

/** The file names a program can have in a folder on PATH, one for each `PATHEXT` ending. */
export function programFileNames(tool: StandinTool, pathext: string | undefined): string[] {
  return (pathext ? pathext : EXTENSIONS_WHEN_UNSET).split(";").filter(Boolean).map((ending) => `${tool}${ending.toLowerCase()}`);
}

/** Whether `tool` is on PATH as a program other than the stand-in or this editor's copies of it. */
export function realOnWindowsPath(
  tool: StandinTool,
  pathVariable: string | undefined,
  pathext: string | undefined,
  own: { standin: string; bin: string },
  files: Pick<ProgramFiles, "isExecutableFile">,
): boolean {
  const names = programFileNames(tool, pathext);
  return windowsPathFolders(pathVariable).some((folder) => path.win32.isAbsolute(folder)
    && !sameWindowsPath(folder, own.bin)
    && names.some((name) => {
      const file = path.win32.join(folder, name);
      return files.isExecutableFile(file) && !sameWindowsPath(file, own.standin);
    }));
}

export function sameWindowsPath(one: string, other: string): boolean {
  return path.win32.resolve(one).toLowerCase() === path.win32.resolve(other).toLowerCase();
}
