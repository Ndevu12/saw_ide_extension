import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { programFileNames, realOnWindowsPath, sameWindowsPath, windowsPathFolders, windowsStandin } from "../../src/core/govern/windowsPlaces";
import { clearCopies, diskCopies, placeCopies, type CopyFiles } from "../../src/editor/govern/standinCopies";
import { tempDir } from "./helpers";

const STANDIN = "C:\\Users\\me\\pipx\\venvs\\stayawakebot\\Lib\\site-packages\\stayawake\\bots\\mcp\\bin\\saw-git-standin.exe";
const BIN = "C:\\Users\\me\\AppData\\Roaming\\Code\\User\\globalStorage\\saw\\govern\\bin";

function programs(...files: string[]): { isExecutableFile: (file: string) => boolean } {
  const known = new Set(files.map((file) => file.toLowerCase()));
  return { isExecutableFile: (file) => known.has(file.toLowerCase()) };
}

describe("saw's git and gh check on Windows", () => {
  it("takes the stand-in saw names when it is a program there", () => {
    expect(windowsStandin(STANDIN, programs(STANDIN))).toBe(STANDIN);
    expect(windowsStandin(STANDIN, programs())).toBeUndefined();
    expect(windowsStandin(undefined, programs(STANDIN))).toBeUndefined();
    expect(windowsStandin("saw-git-standin.exe", programs("saw-git-standin.exe"))).toBeUndefined();
    expect(windowsStandin("C:\\saw\\saw-git-standin", programs("C:\\saw\\saw-git-standin"))).toBeUndefined();
  });

  it("reads PATH and PATHEXT the way the stand-in does", () => {
    expect(windowsPathFolders("C:\\Git\\cmd;;\"C:\\Program Files;x\\bin\";D:\\tools")).toEqual(["C:\\Git\\cmd", "C:\\Program Files;x\\bin", "D:\\tools"]);
    expect(windowsPathFolders(undefined)).toEqual([]);
    expect(programFileNames("git", ".EXE;.CMD")).toEqual(["git.exe", "git.cmd"]);
    expect(programFileNames("gh", undefined)).toEqual(["gh.com", "gh.exe", "gh.bat", "gh.cmd"]);
  });

  it("counts a real git or gh, not the stand-in or this editor's copies of it", () => {
    const own = { standin: STANDIN, bin: BIN };
    const git = "C:\\Program Files\\Git\\cmd\\git.exe";
    const files = programs(STANDIN, `${BIN}\\git.exe`, `${BIN}\\gh.exe`, git);
    expect(realOnWindowsPath("git", BIN, undefined, own, files)).toBe(false);
    expect(realOnWindowsPath("git", BIN.toUpperCase(), undefined, own, files)).toBe(false);
    expect(realOnWindowsPath("git", path.win32.dirname(STANDIN), ".EXE", { standin: STANDIN, bin: BIN }, programs(STANDIN.replace("saw-git-standin", "git"), STANDIN))).toBe(true);
    expect(realOnWindowsPath("git", `${BIN};relative\\bin;C:\\Program Files\\Git\\cmd`, ".COM;.EXE", own, files)).toBe(true);
    expect(realOnWindowsPath("git", "C:\\Program Files\\Git\\cmd", ".COM;.BAT", own, files)).toBe(false);
    expect(realOnWindowsPath("gh", `${BIN};C:\\Program Files\\Git\\cmd`, undefined, own, files)).toBe(false);
    expect(sameWindowsPath("c:\\a\\B\\..\\git.EXE", "C:\\A\\git.exe")).toBe(true);
  });
});

function standinFile(root: string, text: string): string {
  const file = path.join(root, "saw-git-standin.exe");
  writeFileSync(file, text);
  return file;
}

describe("copies of saw's check in the editor's own folder", () => {
  it("copies the stand-in once for each tool with a real program, and takes the rest out", () => {
    const root = tempDir();
    const standin = standinFile(root, "standin 1");
    const bin = path.join(root, "bin");
    expect(placeCopies(standin, bin, ["git", "gh"], diskCopies)).toEqual({ git: path.join(bin, "git.exe"), notRemoved: [] });
    expect(readdirSync(bin).sort()).toEqual(["gh.exe", "git.exe"]);
    expect(readFileSync(path.join(bin, "git.exe"), "utf8")).toBe("standin 1");
    writeFileSync(path.join(bin, "git.exe.1.2.old"), "left over");
    expect(placeCopies(standin, bin, ["gh"], diskCopies)).toEqual({ git: undefined, notRemoved: [] });
    expect(readdirSync(bin)).toEqual(["gh.exe"]);
  });

  it("replaces a copy of an earlier saw, and leaves an identical one alone", () => {
    const root = tempDir();
    const bin = path.join(root, "bin");
    placeCopies(standinFile(root, "standin 1"), bin, ["git"], diskCopies);
    const renamed: string[] = [];
    const watching: CopyFiles = { ...diskCopies, rename: (from, to) => { renamed.push(path.basename(to)); diskCopies.rename(from, to); } };
    placeCopies(standinFile(root, "standin 1"), bin, ["git"], watching);
    expect(renamed).toEqual([]);
    placeCopies(standinFile(root, "standin 2"), bin, ["git"], watching);
    expect(readFileSync(path.join(bin, "git.exe"), "utf8")).toBe("standin 2");
    expect(readdirSync(bin)).toEqual(["git.exe"]);
    expect(renamed.map((name) => name.replace(/\.\d+\.\d+\./, "."))).toEqual(["git.exe.old", "git.exe"]);
  });

  it("moves a running copy aside, says it could not be removed yet, and removes it later", () => {
    const root = tempDir();
    const bin = path.join(root, "bin");
    placeCopies(standinFile(root, "standin 1"), bin, ["git"], diskCopies);
    const running: CopyFiles = {
      ...diskCopies,
      remove: (file) => {
        if (file.endsWith(".old")) {
          throw new Error("EBUSY: resource busy or locked");
        }
        diskCopies.remove(file);
      },
    };
    const copied = placeCopies(standinFile(root, "standin 2"), bin, ["git"], running);
    expect(readFileSync(path.join(bin, "git.exe"), "utf8")).toBe("standin 2");
    expect(copied.notRemoved).toHaveLength(1);
    expect(copied.notRemoved[0]?.file).toMatch(/git\.exe\.\d+\.\d+\.old$/);
    expect(copied.notRemoved[0]?.reason).toMatch(/EBUSY/);
    expect(placeCopies(standinFile(root, "standin 2"), bin, ["git"], diskCopies).notRemoved).toEqual([]);
    expect(readdirSync(bin)).toEqual(["git.exe"]);
  });

  it("puts the earlier copy back when the new one cannot take its place, and says why", () => {
    const root = tempDir();
    const bin = path.join(root, "bin");
    placeCopies(standinFile(root, "standin 1"), bin, ["git"], diskCopies);
    const refusing: CopyFiles = {
      ...diskCopies,
      rename: (from, to) => {
        if (from.endsWith(".new")) {
          throw new Error("EPERM: operation not permitted");
        }
        diskCopies.rename(from, to);
      },
    };
    expect(() => placeCopies(standinFile(root, "standin 2"), bin, ["git"], refusing)).toThrow(/EPERM/);
    expect(readFileSync(path.join(bin, "git.exe"), "utf8")).toBe("standin 1");
  });

  it("clears every copy, naming the ones still in use", () => {
    const root = tempDir();
    const bin = path.join(root, "bin");
    placeCopies(standinFile(root, "standin 1"), bin, ["git", "gh"], diskCopies);
    const gitRunning: CopyFiles = {
      ...diskCopies,
      remove: (file) => {
        if (file.endsWith("git.exe")) {
          throw new Error("EBUSY");
        }
        diskCopies.remove(file);
      },
    };
    expect(clearCopies(bin, gitRunning)).toEqual([{ file: path.join(bin, "git.exe"), reason: "Error: EBUSY" }]);
    expect(readdirSync(bin)).toEqual(["git.exe"]);
    expect(clearCopies(path.join(root, "absent"), diskCopies)).toEqual([]);
  });
});
