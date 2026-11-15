import { describe, expect, it } from "vitest";

import { aliasWords, expandAliases, mayBeAlias } from "../../src/core/govern/alias";
import { cloneTarget } from "../../src/core/govern/clone";
import { parseGit } from "../../src/core/govern/command";
import type { GovernConfig } from "../../src/core/govern/contract";
import { plan } from "../../src/core/govern/plan";

const config: GovernConfig = {
  enabled: true,
  saw: "/usr/local/bin/saw",
  realGit: "/usr/bin/git",
  realGh: "/usr/bin/gh",
  timeoutMs: 1000,
  folders: ["/work/app"],
  holdingRoot: "/tmp/holding",
  markerDir: "/tmp/markers",
  resultDir: "/tmp/results",
  progress: false,
};

describe("the folder a git command acts on", () => {
  it("is the work tree, or the folder holding the git directory, when those are given", () => {
    expect(parseGit(["--git-dir=/work/app/.git", "--work-tree=/work/app", "pull"], "/elsewhere")?.directory).toBe("/work/app");
    expect(parseGit(["--git-dir", "/work/app/.git", "pull"], "/elsewhere")?.directory).toBe("/work/app");
    expect(parseGit(["--work-tree", "../app", "pull"], "/work/other")?.directory).toBe("/work/app");
    expect(parseGit(["-C", "/work", "--git-dir=app/.git", "pull"], "/elsewhere")?.directory).toBe("/work/app");
  });

  it("follows GIT_WORK_TREE and GIT_DIR, and a flag wins over them", () => {
    expect(parseGit(["pull"], "/elsewhere", { GIT_DIR: "/work/app/.git" })?.directory).toBe("/work/app");
    expect(parseGit(["pull"], "/elsewhere", { GIT_WORK_TREE: "/work/app", GIT_DIR: "/x/.git" })?.directory).toBe("/work/app");
    expect(parseGit(["--work-tree=/work/other", "pull"], "/elsewhere", { GIT_WORK_TREE: "/work/app" })?.directory).toBe("/work/other");
  });

  it("holds a pull aimed at an open folder from outside it", () => {
    expect(plan(config, "git", ["--git-dir=/work/app/.git", "--work-tree=/work/app", "pull"], "/elsewhere")).toMatchObject({ kind: "hold", repo: "/work/app" });
    expect(plan(config, "git", ["pull"], "/elsewhere", { env: { GIT_DIR: "/work/app/.git" } })).toMatchObject({ kind: "hold", repo: "/work/app" });
  });
});

describe("git aliases", () => {
  it("are never looked up for a command git ships", () => {
    expect(mayBeAlias("status")).toBe(false);
    expect(mayBeAlias("pull")).toBe(false);
    expect(mayBeAlias("up")).toBe(true);
    let lookups = 0;
    plan(config, "git", ["status"], "/work/app", { aliasOf: () => (lookups += 1, "pull") });
    expect(lookups).toBe(0);
  });

  it("hold an alias for pull given on the command line, as the pull it runs", () => {
    expect(plan(config, "git", ["-c", "alias.up=pull", "up"], "/work/app")).toEqual({
      kind: "hold",
      tool: "git",
      repo: "/work/app",
      holding: expect.stringContaining("/tmp/holding/") as string,
      args: ["-c", "alias.up=pull", "pull"],
    });
  });

  it("hold an alias for pull from the repository's configuration, keeping its own arguments", () => {
    const aliasOf = (name: string, directory: string) => (name === "up" && directory === "/work/app" ? "pull --rebase" : undefined);
    expect(plan(config, "git", ["up", "origin"], "/work/app", { aliasOf })).toMatchObject({ kind: "hold", args: ["pull", "--rebase", "origin"] });
  });

  it("follow one alias to another, and stop on aliases that lead to each other", () => {
    const chain: Record<string, string> = { up: "sync", sync: "pull" };
    expect(plan(config, "git", ["up"], "/work/app", { aliasOf: (name) => chain[name] })).toMatchObject({ kind: "hold", args: ["pull"] });
    const loop: Record<string, string> = { a: "b", b: "a" };
    expect(expandAliases(["a"], "/work/app", { aliasOf: (name) => loop[name] })).toBeUndefined();
    expect(plan(config, "git", ["a"], "/work/app", { aliasOf: (name) => loop[name] })).toMatchObject({ kind: "passthrough" });
  });

  it("leave a shell alias alone, since the git it starts comes back through the stand-in", () => {
    expect(plan(config, "git", ["up"], "/work/app", { aliasOf: () => "!git pull" })).toMatchObject({ kind: "passthrough" });
  });

  it("split their value into words the way git does", () => {
    expect(aliasWords(`log --format="%h %s" -n 3`)).toEqual(["log", "--format=%h %s", "-n", "3"]);
    expect(aliasWords("pull  --rebase  'origin main'")).toEqual(["pull", "--rebase", "origin main"]);
  });
});

describe("a clone into an open folder", () => {
  const clone = (args: string[], cwd: string) => {
    const command = parseGit(["clone", ...args], cwd);
    return command ? cloneTarget(command) : undefined;
  };

  it("lands in the folder named after the URL, or the one given", () => {
    expect(clone(["https://example.com/o/lib.git"], "/work/app")).toBe("/work/app/lib");
    expect(clone(["git@example.com:o/lib.git", "vendor/lib"], "/work/app")).toBe("/work/app/vendor/lib");
    expect(clone(["/srv/repos/lib/.git"], "/work/app")).toBe("/work/app/lib");
    expect(clone(["--depth", "1", "-b", "main", "https://example.com/o/lib", "out"], "/work/app")).toBe("/work/app/out");
  });

  it("runs, and has the folder scanned once it has, since saw cannot hold a clone", () => {
    expect(plan(config, "git", ["clone", "https://example.com/o/lib.git"], "/work/app")).toEqual({ kind: "passthrough", program: "/usr/bin/git", scanAfter: "/work/app" });
    expect(plan(config, "git", ["clone", "https://example.com/o/lib.git", "/work/app/vendor/lib"], "/tmp")).toMatchObject({ scanAfter: "/work/app" });
    expect(plan(config, "git", ["clone", "https://example.com/o/lib.git"], "/tmp")).toEqual({ kind: "passthrough", program: "/usr/bin/git" });
  });
});
