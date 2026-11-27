import { chmodSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { findStandin, governStatusDir, realOnPath, systemGovernBin, type ProgramFiles } from "../../src/core/govern/places";
import { defaultIsExecutableFile, realPath } from "../../src/core/install/locate";
import { tempDir } from "./helpers";

const disk: ProgramFiles = {
  isExecutableFile: defaultIsExecutableFile,
  realpath: realPath,
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
};

function program(file: string): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "#!/bin/sh\n");
  chmodSync(file, 0o755);
  return file;
}

describe.runIf(process.platform !== "win32")("where saw's git and gh check is", () => {
  it("finds it in saw's package, through the link pipx puts on PATH", () => {
    const root = tempDir();
    const venv = path.join(root, "venvs", "stayawakebot");
    const saw = program(path.join(venv, "bin", "saw"));
    const standin = program(path.join(venv, "lib", "python3.12", "site-packages", "stayawake", "bots", "mcp", "bin", "saw-git-standin"));
    const onPath = path.join(root, "bin");
    mkdirSync(onPath);
    symlinkSync(saw, path.join(onPath, "saw"));
    expect(findStandin(path.join(onPath, "saw"), disk)).toBe(standin);
  });

  it("finds it beside saw, and nowhere else", () => {
    const root = tempDir();
    const saw = program(path.join(root, "bin", "saw"));
    expect(findStandin(saw, disk)).toBeUndefined();
    const standin = program(path.join(root, "bin", "saw-git-standin"));
    expect(findStandin(saw, disk)).toBe(standin);
    expect(findStandin("", disk)).toBeUndefined();
  });

  it("counts a real program on PATH, not one that leads to the check itself", () => {
    const root = tempDir();
    const standin = program(path.join(root, "saw", "saw-git-standin"));
    const placed = path.join(root, "placed");
    mkdirSync(placed);
    symlinkSync(standin, path.join(placed, "git"));
    const real = program(path.join(root, "usr", "bin", "git"));
    expect(realOnPath("git", placed, standin, disk)).toBe(false);
    expect(realOnPath("git", [placed, "relative/bin", path.dirname(real)].join(path.delimiter), standin, disk)).toBe(true);
    expect(realOnPath("gh", [placed, path.dirname(real)].join(path.delimiter), standin, disk)).toBe(false);
  });
});

describe("where saw keeps its govern files", () => {
  it("follows the XDG folders, and the usual ones without them", () => {
    expect(systemGovernBin("/xdg", "/home/me")).toBe(path.join("/xdg", "saw", "govern", "bin"));
    expect(systemGovernBin(undefined, "/home/me")).toBe(path.join("/home/me", ".config", "saw", "govern", "bin"));
    expect(governStatusDir("/state", "/home/me")).toBe(path.join("/state", "saw", "govern", "status"));
    expect(governStatusDir(undefined, "/home/me")).toBe(path.join("/home/me", ".local", "state", "saw", "govern", "status"));
    expect(governStatusDir("  ", "/home/me")).toBe(path.join("/home/me", ".local", "state", "saw", "govern", "status"));
  });
});
