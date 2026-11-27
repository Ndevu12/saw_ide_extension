import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { governStatusDir, realOnPath, systemGovernBin, type ProgramFiles } from "../../src/core/govern/places";
import { defaultIsExecutableFile, realPath } from "../../src/core/install/locate";
import { tempDir } from "./helpers";

const disk: ProgramFiles = { isExecutableFile: defaultIsExecutableFile, realpath: realPath };

function program(file: string): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "#!/bin/sh\n");
  chmodSync(file, 0o755);
  return file;
}

describe.runIf(process.platform !== "win32")("git and gh on PATH, on disk", () => {
  it("counts a real program on PATH, not one that leads to saw's check itself", () => {
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
