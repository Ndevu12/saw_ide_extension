import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { keepHooksFolderEmpty, NO_HOOKS, noHooksPath } from "../../src/core/govern/emptyHooks";

const posix = process.platform !== "win32";
const asRoot = posix && process.getuid?.() === 0;

describe("a hooks path that holds no hook", () => {
  const roots: string[] = [];
  const root = () => {
    const made = mkdtempSync(path.join(tmpdir(), "saw-no-hooks-"));
    roots.push(made);
    return made;
  };

  afterEach(() => {
    for (const made of roots.splice(0)) {
      for (const entry of readdirSync(made)) {
        try {
          chmodSync(path.join(made, entry), 0o755);
        } catch {
          // A link or gone.
        }
      }
      rmSync(made, { recursive: true, force: true });
    }
  });

  it("is /dev/null on Linux and macOS, and a folder kept empty on Windows", () => {
    expect(noHooksPath("linux")).toBe(NO_HOOKS);
    expect(noHooksPath("darwin")).toBe(NO_HOOKS);
    expect(noHooksPath("win32")).toBeUndefined();
  });

  it.runIf(posix)("keeps the folder's own hooks from running, and leaves nowhere for an installer to write", () => {
    const repo = path.join(root(), "repo");
    expect(spawnSync("git", ["init", "-q", repo]).status).toBe(0);
    writeFileSync(path.join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho REPO-HOOK-RAN\n", { mode: 0o755 });
    const git = (...args: string[]) => spawnSync("git", ["-c", `core.hooksPath=${NO_HOOKS}`, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" });
    const commit = git("commit", "--allow-empty", "-m", "a");
    expect(commit.status).toBe(0);
    expect(commit.stdout + commit.stderr).not.toContain("REPO-HOOK-RAN");
    expect(git("status", "--porcelain").status).toBe(0);
    const hooks = git("rev-parse", "--git-path", "hooks").stdout.trim();
    expect(hooks).toBe(NO_HOOKS);
    expect(() => mkdirSync(hooks, { recursive: true })).toThrow();
  });

  it("makes the Windows folder, and leaves an empty one as it is", () => {
    const dir = path.join(root(), "empty-hooks");
    expect(keepHooksFolderEmpty(dir)).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
    expect(keepHooksFolderEmpty(dir)).toBeUndefined();
  });

  it("moves aside a folder holding anything, so git never runs it", () => {
    const dir = path.join(root(), "empty-hooks");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "pre-commit"), "#!/bin/sh\necho planted\n", { mode: 0o755 });
    expect(keepHooksFolderEmpty(dir, () => 42)).toBe(`${dir}.found-42`);
    expect(readdirSync(dir)).toEqual([]);
    expect(readdirSync(`${dir}.found-42`)).toEqual(["pre-commit"]);
  });

  it.runIf(posix)("moves aside a link or a file without following it, even a link to an empty folder", () => {
    const base = root();
    const theirs = path.join(base, "operators-hooks");
    mkdirSync(theirs);
    const theirMode = lstatSync(theirs).mode;
    const dir = path.join(base, "empty-hooks");
    symlinkSync(theirs, dir);
    expect(keepHooksFolderEmpty(dir, () => 1)).toBe(`${dir}.found-1`);
    expect(lstatSync(dir).isDirectory()).toBe(true);
    expect(lstatSync(dir).isSymbolicLink()).toBe(false);
    expect(lstatSync(`${dir}.found-1`).isSymbolicLink()).toBe(true);
    expect(lstatSync(theirs).mode).toBe(theirMode);
    const file = path.join(base, "file-hooks");
    writeFileSync(file, "x");
    expect(keepHooksFolderEmpty(file, () => 2)).toBe(`${file}.found-2`);
    expect(lstatSync(file).isDirectory()).toBe(true);
  });

  it.runIf(posix && !asRoot)("throws when it cannot read the folder, instead of calling it empty", () => {
    const dir = path.join(root(), "empty-hooks");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "pre-commit"), "#!/bin/sh\n", { mode: 0o755 });
    chmodSync(dir, 0o311);
    expect(() => keepHooksFolderEmpty(dir)).toThrow(/EACCES/);
    chmodSync(dir, 0o755);
    expect(existsSync(path.join(dir, "pre-commit"))).toBe(true);
  });
});
