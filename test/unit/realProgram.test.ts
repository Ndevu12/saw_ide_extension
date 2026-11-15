import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { posixWrapper } from "../../src/core/govern/plan";
import { checkRealProgram, diskFiles, findRealProgram, isRealProgram, isStandin, pathWithoutStandins, type ProgramFiles } from "../../src/core/govern/realProgram";

const posix = process.platform !== "win32";

describe.runIf(posix)("the real program behind saw's stand-in, on disk", () => {
  let root = "";
  let standin = "";
  let real = "";
  let alias = "";
  let linked = "";
  let otherEditor = "";

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "saw-real-"));
    standin = path.join(root, "govern", "bin");
    real = path.join(root, "usr", "bin");
    alias = path.join(root, "alias");
    linked = path.join(root, "linked");
    otherEditor = path.join(root, "insiders", "govern", "bin");
    for (const dir of [standin, real, linked, otherEditor]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(path.join(standin, "git"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(path.join(real, "git"), "#!/bin/sh\n", { mode: 0o755 });
    symlinkSync(standin, alias);
    symlinkSync(path.join(standin, "git"), path.join(linked, "git"));
    // Another editor's stand-in: a folder this window does not know, holding a wrapper it would write.
    writeFileSync(path.join(otherEditor, "git"), posixWrapper("/usr/bin/node", "/other/govern-shim.js", "/other/config.json", "/usr/bin/git", "git"), { mode: 0o755 });
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const search = (...dirs: string[]) => ({ pathVariable: dirs.join(path.delimiter), platform: process.platform });

  it("looks past the stand-in folder to the real git", () => {
    expect(findRealProgram("git", search(standin, real), [standin], diskFiles)).toBe(path.join(real, "git"));
  });

  it("looks past a symlink to the stand-in folder", () => {
    expect(findRealProgram("git", search(alias, real), [standin], diskFiles)).toBe(path.join(real, "git"));
  });

  it("looks past a git that is a symlink to the stand-in", () => {
    expect(findRealProgram("git", search(linked, real), [standin], diskFiles)).toBe(path.join(real, "git"));
  });

  it("skips a relative PATH entry, which names no folder by itself", () => {
    expect(findRealProgram("git", search("govern/bin", "bin", real), [standin], diskFiles)).toBe(path.join(real, "git"));
  });

  it("looks past another editor's stand-in, by the mark every wrapper carries", () => {
    expect(isRealProgram(path.join(otherEditor, "git"), [standin], diskFiles)).toBe(false);
    expect(findRealProgram("git", search(otherEditor, real), [standin], diskFiles)).toBe(path.join(real, "git"));
  });

  it("says a recorded program is gone, rather than that it leads back, when it is simply not there", () => {
    expect(checkRealProgram(path.join(root, "removed", "git"), "git", [standin], search(standin), diskFiles)).toEqual({ kind: "missing", recorded: path.join(root, "removed", "git"), why: "gone" });
    expect(checkRealProgram("git", "git", [standin], search(standin), diskFiles)).toEqual({ kind: "missing", recorded: "git", why: "leads-back" });
  });

  it("gives saw's stand-in a PATH without the stand-in folders, through a symlink too", () => {
    expect(pathWithoutStandins([standin, alias, real, ""].join(path.delimiter), [standin], diskFiles)).toBe(real);
  });

  it("finds nothing when only the stand-in is on PATH", () => {
    expect(findRealProgram("git", search(standin, alias), [standin], diskFiles)).toBeUndefined();
  });

  it("does not take a bare name, a stand-in, or a symlink to one as the real git", () => {
    expect(isRealProgram("git", [standin], diskFiles)).toBe(false);
    expect(isRealProgram(path.join(standin, "git"), [standin], diskFiles)).toBe(false);
    expect(isRealProgram(path.join(alias, "git"), [standin], diskFiles)).toBe(false);
    expect(isRealProgram(path.join(linked, "git"), [standin], diskFiles)).toBe(false);
    expect(isRealProgram(path.join(real, "git"), [standin], diskFiles)).toBe(true);
  });

  it("replaces a recorded bare git with the real one when the stand-in folders are known", () => {
    expect(checkRealProgram("git", "git", [standin], search(standin, real), diskFiles)).toEqual({ kind: "replaced", program: path.join(real, "git"), recorded: "git", why: "leads-back" });
    expect(checkRealProgram(path.join(real, "git"), "git", [standin], search(standin, real), diskFiles)).toEqual({ kind: "ok", program: path.join(real, "git") });
  });

  it("runs nothing for a recorded bare git when the stand-in folders are not known", () => {
    expect(checkRealProgram("git", "git", undefined, search(standin, real), diskFiles)).toEqual({ kind: "missing", recorded: "git", why: "leads-back" });
    expect(checkRealProgram(path.join(alias, "git"), "git", undefined, search(real), diskFiles).kind).toBe("ok");
  });
});

describe("the real program behind saw's stand-in, by path rules", () => {
  // Folders whose identity ignores case, as on a case-insensitive disk.
  const caseless: ProgramFiles = {
    isExecutableFile: () => true,
    realpath: () => undefined,
    folderIdentity: (dir) => dir.toLowerCase(),
    isMarked: () => false,
  };
  const unreadable: ProgramFiles = { isExecutableFile: () => true, realpath: () => undefined, folderIdentity: () => undefined, isMarked: () => false };

  it("treats a differently cased spelling of the stand-in folder as that folder", () => {
    const search = { pathVariable: "/Home/me/Govern/bin:/usr/bin", platform: "darwin" as const };
    expect(findRealProgram("git", search, ["/home/me/govern/bin"], caseless)).toBe("/usr/bin/git");
  });

  it("matches Windows stand-in paths without case, and finds git.exe past them", () => {
    expect(isStandin("C:\\Users\\Me\\govern\\bin\\git.cmd", ["c:\\users\\me\\govern\\bin"], unreadable, "win32")).toBe(true);
    const search = { pathVariable: "C:\\Users\\Me\\Govern\\Bin;C:\\Program Files\\Git\\cmd", platform: "win32" as const };
    expect(findRealProgram("git", search, ["c:\\users\\me\\govern\\bin"], unreadable)).toBe("C:\\Program Files\\Git\\cmd\\git.exe");
  });
});
