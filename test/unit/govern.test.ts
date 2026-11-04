import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { enclosingFolder, ghBringsFiles, gitBringsFiles, parseGit } from "../../src/core/govern/command";
import { mayRelease, offersGovernVerdict, prepareArgs, readApply, readNotice, readPrepare, readVerdict, sameCheck, unheldAfter, verdictArgs, type GovernConfig } from "../../src/core/govern/contract";
import { activationEnv, governStatusDir, plan, posixWrapper, standinBeside, systemGovernBin } from "../../src/core/govern/plan";
import { report, target } from "./helpers";

const config = (overrides: Partial<GovernConfig> = {}): GovernConfig => ({
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
  ...overrides,
});

function git(argv: string[], cwd = "/work/app") {
  const command = parseGit(argv, cwd);
  return { command, brings: command ? gitBringsFiles(command) : false };
}

describe("which git commands bring files in", () => {
  it("holds a pull, fetch, merge, rebase, checkout, switch, and submodule update", () => {
    for (const argv of [
      ["pull"],
      ["fetch", "origin"],
      ["merge", "main"],
      ["rebase", "origin/main"],
      ["checkout", "main"],
      ["switch", "main"],
      ["submodule", "update", "--init"],
      ["-C", "/work/app", "pull"],
    ]) {
      expect(git(argv).brings, argv.join(" ")).toBe(true);
    }
  });

  it("leaves status, commit, push, a path checkout, a new branch, and an abort alone", () => {
    for (const argv of [
      ["status"],
      ["diff"],
      ["log"],
      ["commit", "-m", "wip"],
      ["push"],
      ["checkout", "--", "README.md"],
      ["checkout", "-b", "feature"],
      ["switch", "-c", "feature"],
      ["merge", "--abort"],
      ["rebase", "--quit"],
      ["fetch", "--dry-run"],
      ["submodule", "status"],
    ]) {
      expect(git(argv).brings, argv.join(" ")).toBe(false);
    }
  });

  it("uses -C as the directory, including the attached form", () => {
    expect(parseGit(["-C", "/other", "pull"], "/work/app")?.directory).toBe(path.resolve("/other"));
    expect(parseGit(["-C/other", "status"], "/work/app")?.directory).toBe(path.resolve("/other"));
    expect(parseGit(["-c", "a.b=c", "pull"], "/work/app")?.subcommand).toBe("pull");
  });
});

describe("which gh commands land files", () => {
  it("holds a pull-request checkout, a sync, and a download", () => {
    expect(ghBringsFiles(["pr", "checkout", "12"])).toBe(true);
    expect(ghBringsFiles(["repo", "sync"])).toBe(true);
    expect(ghBringsFiles(["release", "download"])).toBe(true);
    expect(ghBringsFiles(["run", "download", "4"])).toBe(true);
  });

  it("leaves reading GitHub alone", () => {
    expect(ghBringsFiles(["pr", "view"])).toBe(false);
    expect(ghBringsFiles(["issue", "list"])).toBe(false);
    expect(ghBringsFiles(["repo", "clone", "acme/app"])).toBe(false);
  });
});

describe("the open folder a command targets", () => {
  it("is the innermost open folder that contains the directory", () => {
    expect(enclosingFolder(["/work", "/work/app"], "/work/app/src")).toBe(path.resolve("/work/app"));
    expect(enclosingFolder(["/work/app"], "/other")).toBeUndefined();
  });
});

describe("what the stand-in does", () => {
  it("runs the real git unless the command brings files into an open folder", () => {
    expect(plan(config(), "git", ["status"], "/work/app")).toEqual({ kind: "passthrough", program: "/usr/bin/git" });
    expect(plan(config(), "git", ["-C", "/other", "pull"], "/work/app")).toEqual({ kind: "passthrough", program: "/usr/bin/git" });
    expect(plan(config({ enabled: false }), "git", ["pull"], "/work/app")).toEqual({ kind: "passthrough", program: "/usr/bin/git" });
    const held = plan(config(), "git", ["pull", "origin", "main"], "/work/app/src");
    expect(held.kind).toBe("hold");
    if (held.kind === "hold") {
      expect(held.repo).toBe(path.resolve("/work/app"));
      expect(held.args).toEqual(["pull", "origin", "main"]);
    }
  });

  it("asks saw for progress events only when that saw reports them", () => {
    expect(prepareArgs("/work/app", "/tmp/holding/abc", "git", ["pull"], true)).toContain("--progress=jsonl");
    expect(prepareArgs("/work/app", "/tmp/holding/abc", "git", ["pull"])).not.toContain("--progress=jsonl");
  });

  it("asks saw to prepare that folder, and nothing else", () => {
    expect(prepareArgs("/work/app", "/tmp/holding/abc", "git", ["pull", "origin"])).toEqual([
      "govern", "prepare", "--json", "--repo", "/work/app", "--into", "/tmp/holding/abc", "--tool", "git", "--", "pull", "origin",
    ]);
  });

  it("places saw's stand-in when it sits beside saw, and activates it", () => {
    const saw = path.join("/usr/local/bin", "saw");
    const standin = path.join("/usr/local/bin", "saw-git-standin");
    const present = new Set([standin]);
    expect(standinBeside(saw, (file) => present.has(file))).toBe(standin);
    expect(standinBeside(saw, () => false)).toBeUndefined();
    expect(systemGovernBin("/xdg", "/home/me")).toBe(path.join("/xdg", "saw", "govern", "bin"));
    expect(systemGovernBin(undefined, "/home/me")).toBe(path.join("/home/me", ".config", "saw", "govern", "bin"));
    expect(governStatusDir("/state", "/home/me")).toBe(path.join("/state", "saw", "govern", "status"));
    expect(governStatusDir(undefined, "/home/me")).toBe(path.join("/home/me", ".local", "state", "saw", "govern", "status"));
    expect(governStatusDir("  ", "/home/me")).toBe(path.join("/home/me", ".local", "state", "saw", "govern", "status"));
    expect(activationEnv(config(), "git", "/tmp/holding/app")).toEqual({
      SAW_GOVERN_HOLDING: "/tmp/holding/app",
      SAW_REAL_GIT: "/usr/bin/git",
      SAW_REAL_GH: "/usr/bin/gh",
      SAW_BIN: "/usr/local/bin/saw",
      SAW_STANDIN_TOOL: "git",
    });
  });

  it("falls through to the real program when its configuration is gone", () => {
    const wrapper = posixWrapper("/usr/bin/node", "/ext/govern-shim.js", "/ext/config.json", "/usr/bin/git", "git");
    expect(wrapper).toContain("exec '/usr/bin/git' \"$@\"");
    expect(wrapper).toContain("--tool git");
  });
});

describe("saw govern's report", () => {
  it("releases a clean or residue scan and holds every other verdict", () => {
    expect(mayRelease("clean")).toBe(true);
    expect(mayRelease("residue")).toBe(true);
    expect(mayRelease("suspicious")).toBe(false);
    expect(mayRelease("infected")).toBe(false);
    expect(mayRelease("incomplete")).toBe(false);
    const clean = readPrepare(JSON.stringify({ schema_version: 1, scan: JSON.parse(report([target()])) }), 0);
    expect(clean).toMatchObject({ verdict: "clean", release: true });
    const infected = readPrepare(JSON.stringify({ schema_version: 1, scan: JSON.parse(report([target({ verdict: "infected" })])) }), 1);
    expect(infected.release).toBe(false);
    expect(infected.verdict).toBe("infected");
  });

  it("does not release a report it cannot read", () => {
    expect(readPrepare("not json", 0)).toMatchObject({ verdict: "incomplete", release: false });
    expect(readPrepare(JSON.stringify({ schema_version: 2, scan: {} }), 0).reasons.join(" ")).toMatch(/update the extension/);
    expect(readPrepare(JSON.stringify({ schema_version: 1, reason: "the update could not be prepared" }), 2)).toMatchObject({
      verdict: "incomplete",
      release: false,
    });
  });

  it("reads a checking notice, and ignores a file that is not one", () => {
    expect(readNotice(JSON.stringify({ repo: "/work/app", phase: "checking", step: "reading git history (2/6)", reasons: [], at: 1 }))).toMatchObject({
      phase: "checking",
      step: "reading git history (2/6)",
    });
    expect(readNotice(JSON.stringify({ repo: "/work/app", phase: "held", verdict: "infected", reasons: ["a workflow arrived"], at: 2 }))?.phase).toBe("held");
    expect(readNotice(JSON.stringify({ repo: "/work/app", phase: "finished", reasons: [], at: 3 }))?.phase).toBe("finished");
    expect(readNotice("not json")).toBeUndefined();
    expect(readNotice(JSON.stringify({ released: true }))).toBeUndefined();
  });

  it("reads whether saw let the tree in, and treats anything else as no answer", () => {
    expect(verdictArgs("/work/app")).toEqual(["govern", "verdict", "--json", "--repo", "/work/app"]);
    expect(readVerdict(JSON.stringify({ schema_version: 1, governed: "let-in", reason: "this tree is one saw let in" }))).toBe("let-in");
    expect(readVerdict(JSON.stringify({ schema_version: 1, governed: "not-let-in", reason: "this tree is not one saw let in" }))).toBe("not-let-in");
    expect(readVerdict(JSON.stringify({ schema_version: 1, governed: "could-not-answer", reason: "the open folder has no commit yet" }))).toBe("could-not-answer");
    expect(readVerdict(JSON.stringify({ schema_version: 1, governed: "clean" }))).toBe("could-not-answer");
    expect(readVerdict("not json")).toBe("could-not-answer");
    expect(readVerdict(JSON.stringify({ schema_version: 2, governed: "let-in" }))).toBe("could-not-answer");
  });

  it("calls out a tree saw did not let in, and stays quiet when saw already let it in", () => {
    expect(unheldAfter("let-in", true)).toBe("clear");
    expect(unheldAfter("let-in", false)).toBe("clear");
    expect(unheldAfter("not-let-in", true)).toBe("mark");
    expect(unheldAfter("not-let-in", false)).toBe("mark");
    expect(unheldAfter("could-not-answer", true)).toBe("leave");
    expect(unheldAfter("could-not-answer", false)).toBe("leave");
    expect(unheldAfter(undefined, true)).toBe("leave");
    expect(unheldAfter(undefined, false)).toBe("mark");
  });

  it("recognises saw's verdict command from its help, and not an older govern", () => {
    expect(offersGovernVerdict("  {prepare,apply,verdict,install}\n")).toBe(true);
    expect(offersGovernVerdict("  verdict  say whether the open folder's tree is one saw let in\n")).toBe(true);
    expect(offersGovernVerdict("  {prepare,apply,install,status,uninstall}\n")).toBe(false);
  });

  it("shows one check once when saw and this window both write it", () => {
    expect(sameCheck(undefined, 5_000, 5_000)).toBe(false);
    expect(sameCheck(1_000, 1_050, 5_000)).toBe(true);
    expect(sameCheck(1_050, 1_000, 5_000)).toBe(true);
    expect(sameCheck(1_000, 7_000, 5_000)).toBe(false);
  });

  it("treats apply as done only when saw says the folder was updated", () => {
    expect(readApply(JSON.stringify({ schema_version: 1, applied: true }))).toEqual({ applied: true, reason: undefined });
    expect(readApply(JSON.stringify({ schema_version: 1, applied: false, reason: "left unchanged" })).applied).toBe(false);
    expect(readApply("").applied).toBe(false);
  });
});
